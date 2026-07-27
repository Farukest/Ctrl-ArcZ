import { concatHex, encodePacked, keccak256, stringToHex, toHex, type Hex } from 'viem';

export interface ClaimSecret {
  /**
   * The one string a human carries: 16 Crockford base32 characters, grouped for
   * reading (`A4K7-9QMX-2PR6-TH8D`). This is the whole credential.
   */
  secret: string;
  /** What `claim` sends as the code. Identical to `secret`, normalised. */
  code: string;
  /** Derived from the secret, not independent entropy. Never transmitted. */
  salt: Hex;
  /** `keccak256(abi.encodePacked(salt, code))`. The only part that goes on-chain. */
  claimHash: Hex;
}

/**
 * Crockford base32: no I, L, O or U. The first three are dropped because they are
 * unreadable next to 1 and 0 when a person copies a code off a screen, and U so that
 * no random string spells something the sender has to read out loud.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_CHARS = 16;
const GROUP = 4;

/** Bits carried by the secret: 16 chars x 5 bits. */
export const CLAIM_SECRET_BITS = SECRET_CHARS * 5;

/**
 * Mints a claim secret.
 *
 * SECURITY — all the entropy lives in the one string a human carries.
 *
 * `claim` pays the recipient recorded on-chain, and in a poisoning attack that
 * recipient IS the attacker. They can grind `claimHash` offline for as long as they
 * like, so the secret has to be too large to grind: 80 bits, versus the ~20 bits a
 * 6-digit code would carry.
 *
 * The salt is derived from the secret rather than being separate entropy, so there
 * is nothing to deliver besides the string itself. That matters more than it looks:
 * any channel that delivers a second half BY ADDRESS (on-chain ciphertext, a
 * backend, a push) delivers it to the attacker too, because the address is theirs.
 * The secret must reach a human through a channel the attacker is not in.
 *
 * Never reuse a secret across transfers: a settled claim publishes it in calldata
 * forever.
 */
export function generateClaimCode(): ClaimSecret {
  const secret = randomSecret();
  return fromSecret(secret);
}

/** Everything a claim needs, derived from the string the recipient typed. */
export function fromSecret(secret: string): ClaimSecret {
  const code = normaliseSecret(secret);
  if (!code) throw new Error('invalid claim secret');
  const salt = saltFromSecret(code);
  return { secret: formatSecret(code), code, salt, claimHash: hashClaim(salt, code) };
}

/**
 * Accept what a human actually types: any grouping, any case, and the three
 * characters Crockford treats as aliases (I and L for 1, O for zero). Returns null
 * if it is not a well-formed secret.
 */
export function normaliseSecret(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== SECRET_CHARS) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
  return cleaned;
}

/** Group into fours for display. Never send an ungrouped secret to a human. */
export function formatSecret(secret: string): string {
  return (secret.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? []).join('-');
}

/** The salt is a domain-separated hash of the secret, so the secret is the only
 *  thing that ever has to travel. */
export function saltFromSecret(secret: string): Hex {
  return keccak256(concatHex([stringToHex('ctrl-arcz:salt:v1'), stringToHex(secret)]));
}

/** The commitment, derived exactly as `CodeClaimVerifier` does on-chain. */
export function hashClaim(salt: Hex, code: string): Hex {
  return keccak256(encodePacked(['bytes32', 'string'], [salt, code]));
}

/**
 * Uniform characters from the CSPRNG. Rejection sampling, because `% 32` on a raw
 * byte would bias the early characters — a small bias, but there is no reason to
 * accept one in the secret that guards the money.
 */
function randomSecret(): string {
  const out: string[] = [];
  const buffer = new Uint8Array(1);
  while (out.length < SECRET_CHARS) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    // 256 is not a multiple of 32; 224 is, so anything above it would skew.
    if (value < 224) out.push(ALPHABET[value % 32] as string);
  }
  return out.join('');
}

/** Kept for callers that still hold raw bytes; not used by the claim flow. */
export function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
