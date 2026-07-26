import {
  decodeAbiParameters,
  encodeAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { stealthAnnouncerAbi } from './abi.js';
import { getLogsChunked } from '../events.js';
import {
  STEALTH_SCHEME_ID,
  checkStealthAddress,
  generateStealthAddress,
  type StealthKeys,
  type StealthMetaAddress,
} from './stealth.js';

/**
 * On-chain glue for stealth boxes: announce a freshly created box so its payer can
 * find it, and scan announcements to discover one's own boxes. The cryptography
 * lives in `stealth.ts`; this file only encodes/decodes the announcement and talks
 * to the {@link stealthAnnouncerAbi} registry.
 */

/** A stealth announcement's decoded payload: which box, at which stealth address. */
export interface StealthBox {
  /** The fresh address that owns/vaults the box (matched to the payer's keys). */
  stealthAddress: Address;
  /** The spend box (SpendPolicyAccount) this announcement points at. */
  box: Address;
  /** The ephemeral public key that produced the stealth address. */
  ephemeralPubKey: Hex;
}

/** Pack the box address into announcement metadata (ABI address; room to extend). */
export function encodeStealthMetadata(box: Address): Hex {
  return encodeAbiParameters([{ type: 'address' }], [box]);
}

export function decodeStealthMetadata(metadata: Hex): Address {
  return decodeAbiParameters([{ type: 'address' }], metadata)[0];
}

/**
 * A fresh stealth owner for a new box. Use the returned `stealthAddress` as BOTH the
 * box's owner and vault (so its `ownerHash`/`vaultHash` carry no link to the payer).
 * The box address is not known until it is created, so announcing is a second step
 * (see {@link announceArgsFor}). `ephemeralKey` is injectable for deterministic tests.
 */
export function newStealthOwner(
  meta: StealthMetaAddress,
  ephemeralKey?: Hex,
): { stealthAddress: Address; ephemeralPubKey: Hex; viewTag: number } {
  return generateStealthAddress(meta, ephemeralKey);
}

/** The `announce(...)` arguments for a created box, tying its ephemeral key to the
 *  box address so the payer's scan lands straight on the box. */
export function announceArgsFor(
  stealth: { stealthAddress: Address; ephemeralPubKey: Hex },
  box: Address,
): readonly [bigint, Address, Hex, Hex] {
  return [
    BigInt(STEALTH_SCHEME_ID),
    stealth.stealthAddress,
    stealth.ephemeralPubKey,
    encodeStealthMetadata(box),
  ] as const;
}

/** Raw announcement fields, as read from the registry log. */
export interface RawAnnouncement {
  stealthAddress: Address;
  ephemeralPubKey: Hex;
  metadata: Hex;
}

/**
 * Pure recognition: from the payer's keys and a batch of announcements, return the
 * ones that belong to them. An announcement is theirs iff re-deriving the stealth
 * address from its ephemeral key and their viewing/spending keys reproduces the
 * announced address. A stranger cannot do this without the viewing key.
 */
export function recognizeAnnouncements(
  keys: Pick<StealthKeys, 'viewingKey' | 'spendingPub'>,
  announcements: RawAnnouncement[],
): StealthBox[] {
  const mine: StealthBox[] = [];
  for (const a of announcements) {
    let recovered: Address | null = null;
    try {
      recovered = checkStealthAddress({
        viewingKey: keys.viewingKey,
        spendingPub: keys.spendingPub,
        ephemeralPubKey: a.ephemeralPubKey,
      });
    } catch {
      continue; // a malformed ephemeral key is not ours
    }
    if (recovered && recovered.toLowerCase() === a.stealthAddress.toLowerCase()) {
      try {
        mine.push({ stealthAddress: a.stealthAddress, box: decodeStealthMetadata(a.metadata), ephemeralPubKey: a.ephemeralPubKey });
      } catch {
        /* announcement without a decodable box: skip */
      }
    }
  }
  return mine;
}

/** Emit an announcement for a created box. Any submitter works; a relayer keeps the
 *  payer's address off the announcement transaction. */
export async function announceStealthBox(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  announcer: Address,
  announceArgs: readonly [bigint, Address, Hex, Hex],
): Promise<Hex> {
  const account = clients.walletClient.account;
  if (!account) throw new Error('announceStealthBox: wallet has no account');
  const hash = await clients.walletClient.writeContract({
    address: announcer,
    abi: stealthAnnouncerAbi,
    functionName: 'announce',
    args: announceArgs,
    account,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Scan the announcement registry and return the caller's own stealth boxes. */
export async function discoverStealthBoxes(
  publicClient: PublicClient,
  announcer: Address,
  keys: Pick<StealthKeys, 'viewingKey' | 'spendingPub'>,
  opts: { fromBlock?: bigint } = {},
): Promise<StealthBox[]> {
  const logs = await getLogsChunked<{ stealthAddress?: Address; ephemeralPubKey?: Hex; metadata?: Hex }>(
    publicClient,
    {
      address: announcer,
      abi: stealthAnnouncerAbi,
      eventName: 'Announcement',
      args: { schemeId: BigInt(STEALTH_SCHEME_ID) },
      ...(opts.fromBlock !== undefined ? { fromBlock: opts.fromBlock } : {}),
    },
  );
  const raw: RawAnnouncement[] = logs
    .filter((l) => l.args.stealthAddress && l.args.ephemeralPubKey && l.args.metadata)
    .map((l) => ({
      stealthAddress: l.args.stealthAddress as Address,
      ephemeralPubKey: l.args.ephemeralPubKey as Hex,
      metadata: l.args.metadata as Hex,
    }));
  return recognizeAnnouncements(keys, raw);
}
