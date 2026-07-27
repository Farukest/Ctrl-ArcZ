import { describe, expect, it } from 'vitest';
import { encodePacked, keccak256 } from 'viem';
import {
  CLAIM_SECRET_BITS,
  formatSecret,
  fromSecret,
  generateClaimCode,
  hashClaim,
  normaliseSecret,
  saltFromSecret,
} from '../src/transfer/claimCode.js';

const ALPHABET = /^[0-9A-HJKMNP-TV-Z]{16}$/; // Crockford: no I, L, O, U

describe('generateClaimCode', () => {
  it('produces one grouped secret carrying every bit of the proof', () => {
    const { secret, code, salt } = generateClaimCode();

    expect(secret).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(code).toMatch(ALPHABET);
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(CLAIM_SECRET_BITS).toBe(80);
  });

  it('derives the hash exactly as the contract does', () => {
    const { code, salt, claimHash } = generateClaimCode();

    expect(claimHash).toBe(keccak256(encodePacked(['bytes32', 'string'], [salt, code])));
    expect(hashClaim(salt, code)).toBe(claimHash);
  });

  /**
   * 80 bits is what stops an offline brute force against the on-chain claimHash.
   * In a poisoning attack the recorded recipient IS the attacker, so they can grind
   * for as long as they like; a repeat would hand them a second transfer for free.
   */
  it('never repeats a secret', () => {
    const secrets = new Set(Array.from({ length: 500 }, () => generateClaimCode().code));
    expect(secrets.size).toBe(500);
  });

  it('spreads characters across the whole alphabet', () => {
    const secrets = Array.from({ length: 300 }, () => generateClaimCode().code);

    // Every position must vary; a constant one would mean a broken RNG.
    for (let position = 0; position < 16; position++) {
      const distinct = new Set(secrets.map((s) => s[position]));
      expect(distinct.size).toBeGreaterThan(8);
    }
    expect(secrets.every((s) => ALPHABET.test(s))).toBe(true);
  });

  it('a different secret yields a different hash', () => {
    const { code, claimHash } = generateClaimCode();
    const other = code === '0'.repeat(16) ? '1'.repeat(16) : '0'.repeat(16);

    expect(hashClaim(saltFromSecret(other), other)).not.toBe(claimHash);
  });
});

describe('normaliseSecret', () => {
  it('accepts what a human actually types', () => {
    const { code } = generateClaimCode();
    const grouped = formatSecret(code);

    expect(normaliseSecret(grouped)).toBe(code);
    expect(normaliseSecret(grouped.toLowerCase())).toBe(code);
    expect(normaliseSecret(` ${grouped} `)).toBe(code);
    expect(normaliseSecret(grouped.replace(/-/g, ' '))).toBe(code);
  });

  it('maps the characters Crockford treats as aliases', () => {
    // I and L read as 1, O reads as 0 when a person copies a code off a screen.
    expect(normaliseSecret('IL0O123456789ABC')).toBe('1100123456789ABC');
  });

  it('rejects anything that is not a well-formed secret', () => {
    expect(normaliseSecret('')).toBeNull();
    expect(normaliseSecret('123456')).toBeNull(); // the old 6-digit code
    expect(normaliseSecret('0123456789ABCDEU')).toBeNull(); // U is not in the alphabet
    expect(normaliseSecret('0123456789ABCDE!')).toBeNull();
    expect(normaliseSecret('0123456789ABCDEFG')).toBeNull(); // too long
  });

  it('round-trips through fromSecret to the same claim hash', () => {
    const minted = generateClaimCode();
    const rebuilt = fromSecret(minted.secret);

    expect(rebuilt.code).toBe(minted.code);
    expect(rebuilt.salt).toBe(minted.salt);
    expect(rebuilt.claimHash).toBe(minted.claimHash);
  });

  it('rejects a secret it cannot parse rather than claiming with a wrong one', () => {
    expect(() => fromSecret('nope')).toThrow();
  });
});
