import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils';
import { getAddress, keccak256, type Address, type Hex } from 'viem';

/**
 * Stealth addresses for the payer shield, following the ERC-5564 secp256k1 scheme
 * (schemeId 1).
 *
 * WHY — a spend box today carries `ownerHash = keccak256(owner)` in its creation
 * event and, if the vault is the owner, `vaultHash = keccak256(owner)` in its state.
 * Both are one-way, but anyone who already suspects an address can hash it and
 * CONFIRM which boxes are that owner's (a linkability, not a discovery, leak). A
 * stealth address breaks this: each box is owned/vaulted by a fresh address that
 * only the payer can recognise (with their viewing key) or spend from (with their
 * spending key), so a third party cannot test ownership even knowing the payer's
 * main address.
 *
 * This module is pure cryptography — no chain access. The funding leg (main wallet
 * to box) is a separate, money-flow leak that only a confidential transfer layer
 * (Arc Privacy Sector) can close; stealth addresses close the identity-tag leak.
 */

export const STEALTH_SCHEME_ID = 1;

/** The message the wallet signs once to derive its stealth keys deterministically.
 *  Same wallet, same signature (RFC 6979), so the keys are recoverable anywhere. */
export const STEALTH_KEY_MESSAGE =
  'Ctrl+ArcZ stealth keys v1\n\nSign to derive your private stealth keys. This does not cost gas and never moves funds.';

const N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;

/** A published stealth meta-address: the payer's two long-lived public keys. */
export interface StealthMetaAddress {
  /** Compressed secp256k1 point (33 bytes, hex). Funds are derived against this. */
  spendingPub: Hex;
  /** Compressed secp256k1 point (33 bytes, hex). Only this key scans announcements. */
  viewingPub: Hex;
}

/** The payer's full stealth key set. Private keys never leave the client. */
export interface StealthKeys extends StealthMetaAddress {
  spendingKey: Hex;
  viewingKey: Hex;
}

/** What the creator publishes so the payer can later find and spend the box. */
export interface StealthAnnouncement {
  /** The fresh address the box is owned/vaulted by. */
  stealthAddress: Address;
  /** Compressed ephemeral public key (33 bytes, hex); the scan input. */
  ephemeralPubKey: Hex;
  /** First byte of the shared secret; lets a scanner skip non-matches cheaply. */
  viewTag: number;
}

function privToScalar(label: number, seed: Hex): bigint {
  // keccak(sig || label) reduced into [1, n). Distinct labels give independent keys.
  const h = keccak256(`${seed}${label.toString(16).padStart(2, '0')}` as Hex);
  const s = bytesToNumberBE(hexToBytes(h.slice(2) as Hex)) % N;
  return s === 0n ? 1n : s;
}

function scalarToHex(s: bigint): Hex {
  return `0x${bytesToHex(numberToBytesBE(s, 32))}` as Hex;
}

function compressedPub(scalar: bigint): Hex {
  return `0x${bytesToHex(G.multiply(scalar).toRawBytes(true))}` as Hex;
}

function pointToAddress(point: InstanceType<typeof secp256k1.ProjectivePoint>): Address {
  // Uncompressed is 0x04 || X(32) || Y(32); the address is keccak(X||Y)[-20:].
  const uncompressed = point.toRawBytes(false).slice(1);
  const hash = keccak256(`0x${bytesToHex(uncompressed)}` as Hex);
  return getAddress(`0x${hash.slice(-40)}` as Hex);
}

/** Shared secret scalar and its view tag from an ECDH point (the hashed secret). */
function sharedSecret(point: InstanceType<typeof secp256k1.ProjectivePoint>): { scalar: bigint; viewTag: number } {
  const hash = keccak256(`0x${bytesToHex(point.toRawBytes(true))}` as Hex);
  const bytes = hexToBytes(hash.slice(2) as Hex);
  return { scalar: bytesToNumberBE(bytes) % N, viewTag: bytes[0]! };
}

/**
 * Derive a payer's stealth keys from their one-time signature over
 * {@link STEALTH_KEY_MESSAGE}. Deterministic: the same signature always yields the
 * same keys, so the payer never stores them.
 */
export function deriveStealthKeys(signature: Hex): StealthKeys {
  const spendingKey = privToScalar(0, signature);
  const viewingKey = privToScalar(1, signature);
  return {
    spendingKey: scalarToHex(spendingKey),
    viewingKey: scalarToHex(viewingKey),
    spendingPub: compressedPub(spendingKey),
    viewingPub: compressedPub(viewingKey),
  };
}

/**
 * Create a fresh stealth address for a meta-address (the payer). Called by whoever
 * sets up the box. Returns the address plus what to announce so the payer can find
 * it. `ephemeralKey` is injectable for deterministic tests; omit it in production.
 */
export function generateStealthAddress(
  meta: StealthMetaAddress,
  ephemeralKey?: Hex,
): StealthAnnouncement {
  const ephScalar = ephemeralKey
    ? bytesToNumberBE(hexToBytes(ephemeralKey.slice(2) as Hex)) % N
    : bytesToNumberBE(secp256k1.utils.randomPrivateKey()) % N;
  const eph = ephScalar === 0n ? 1n : ephScalar;

  const viewingPoint = secp256k1.ProjectivePoint.fromHex(meta.viewingPub.slice(2));
  const { scalar, viewTag } = sharedSecret(viewingPoint.multiply(eph));

  const spendingPoint = secp256k1.ProjectivePoint.fromHex(meta.spendingPub.slice(2));
  const stealthPoint = spendingPoint.add(G.multiply(scalar));

  return {
    stealthAddress: pointToAddress(stealthPoint),
    ephemeralPubKey: `0x${bytesToHex(G.multiply(eph).toRawBytes(true))}` as Hex,
    viewTag,
  };
}

/**
 * Scan one announcement with the payer's viewing key. Returns the stealth address if
 * it belongs to this meta-address, else null. The view tag is checked first so the
 * common (non-matching) case skips the point add.
 */
export function checkStealthAddress(params: {
  viewingKey: Hex;
  spendingPub: Hex;
  ephemeralPubKey: Hex;
  viewTag?: number;
}): Address | null {
  const viewingScalar = bytesToNumberBE(hexToBytes(params.viewingKey.slice(2) as Hex)) % N;
  const ephPoint = secp256k1.ProjectivePoint.fromHex(params.ephemeralPubKey.slice(2));
  const { scalar, viewTag } = sharedSecret(ephPoint.multiply(viewingScalar));
  if (params.viewTag !== undefined && params.viewTag !== viewTag) return null;

  const spendingPoint = secp256k1.ProjectivePoint.fromHex(params.spendingPub.slice(2));
  return pointToAddress(spendingPoint.add(G.multiply(scalar)));
}

/**
 * The private key that controls a stealth address, so the payer can sign for it (e.g.
 * to sweep the box home). Only the holder of the spending AND viewing keys can
 * compute it.
 */
export function computeStealthPrivateKey(params: {
  spendingKey: Hex;
  viewingKey: Hex;
  ephemeralPubKey: Hex;
}): Hex {
  const spendingScalar = bytesToNumberBE(hexToBytes(params.spendingKey.slice(2) as Hex)) % N;
  const viewingScalar = bytesToNumberBE(hexToBytes(params.viewingKey.slice(2) as Hex)) % N;
  const ephPoint = secp256k1.ProjectivePoint.fromHex(params.ephemeralPubKey.slice(2));
  const { scalar } = sharedSecret(ephPoint.multiply(viewingScalar));
  return scalarToHex((spendingScalar + scalar) % N);
}
