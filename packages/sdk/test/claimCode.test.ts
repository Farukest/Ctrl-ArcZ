import { describe, expect, it } from 'vitest';
import { encodePacked, keccak256 } from 'viem';
import { generateClaimCode, hashClaim } from '../src/transfer/claimCode.js';

describe('generateClaimCode', () => {
  it('produces a 6-digit code and a 32-byte salt', () => {
    const { code, salt } = generateClaimCode();

    expect(code).toMatch(/^\d{6}$/);
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('derives the hash exactly as the contract does', () => {
    const { code, salt, claimHash } = generateClaimCode();

    expect(claimHash).toBe(keccak256(encodePacked(['bytes32', 'string'], [salt, code])));
    expect(hashClaim(salt, code)).toBe(claimHash);
  });

  /**
   * The salt — not the code — is what stops an offline brute force. A repeated
   * salt would let one settled claim unlock another transfer.
   */
  it('never repeats a salt', () => {
    const salts = new Set(Array.from({ length: 500 }, () => generateClaimCode().salt));
    expect(salts.size).toBe(500);
  });

  it('spreads codes across the whole 6-digit space', () => {
    const codes = Array.from({ length: 300 }, () => generateClaimCode().code);

    // Every digit position must vary; a constant position would mean a broken RNG.
    for (let position = 0; position < 6; position++) {
      const distinct = new Set(codes.map((c) => c[position]));
      expect(distinct.size).toBeGreaterThan(3);
    }
    // Leading zeros are legal codes and must not be dropped.
    expect(codes.every((c) => c.length === 6)).toBe(true);
  });

  it('a different code with the same salt yields a different hash', () => {
    const { salt, code, claimHash } = generateClaimCode();
    const other = code === '000000' ? '111111' : '000000';

    expect(hashClaim(salt, other)).not.toBe(claimHash);
  });
});
