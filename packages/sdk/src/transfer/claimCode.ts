import { encodePacked, keccak256, toHex, type Hex } from 'viem';

export interface ClaimSecret {
  /** The 6-digit code a human reads out. */
  code: string;
  /** 32 secret bytes. Delivered to the recipient with the claim link — never published. */
  salt: Hex;
  /** `keccak256(abi.encodePacked(salt, code))`. The only part that goes on-chain. */
  claimHash: Hex;
}

const CODE_DIGITS = 6;

/**
 * Mints a claim secret.
 *
 * SECURITY — the salt is the secret, the code is the human factor.
 *
 * A 6-digit code is ~20 bits. If the salt were public, anyone could brute-force
 * the code offline in milliseconds and call `claim` — and because `claim` pays the
 * recipient recorded on-chain, in a poisoning attack that recipient IS the
 * attacker. So the salt is 256 random bits and must reach the recipient
 * out-of-band (claim link / QR) while the code is spoken or typed. The chain only
 * ever sees the hash.
 *
 * Never reuse a secret across transfers: a settled claim publishes both halves in
 * its calldata forever.
 */
export function generateClaimCode(): ClaimSecret {
  const code = randomDigits(CODE_DIGITS);
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { code, salt, claimHash: hashClaim(salt, code) };
}

/** The commitment, derived exactly as `CodeClaimVerifier` does on-chain. */
export function hashClaim(salt: Hex, code: string): Hex {
  return keccak256(encodePacked(['bytes32', 'string'], [salt, code]));
}

/**
 * Uniform digits from the CSPRNG. Rejection sampling, because `% 10` on a raw
 * byte would bias the low digits — a small bias, but there is no reason to accept
 * one in the secret that guards the money.
 */
function randomDigits(length: number): string {
  const digits: string[] = [];
  const buffer = new Uint8Array(1);

  while (digits.length < length) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value < 250) digits.push(String(value % 10));
  }

  return digits.join('');
}
