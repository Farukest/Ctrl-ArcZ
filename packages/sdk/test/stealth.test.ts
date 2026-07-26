import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  deriveStealthKeys,
  generateStealthAddress,
  checkStealthAddress,
  computeStealthPrivateKey,
} from '../src/shield/stealth.js';

// A fixed "wallet signature" over STEALTH_KEY_MESSAGE (65-byte ECDSA sig, hex).
const SIG_A =
  '0x9a8be0e7f2b1c4d6e8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f701b' as Hex;
const SIG_B =
  '0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff001b' as Hex;

describe('stealth addresses (ERC-5564 secp256k1)', () => {
  it('derives deterministic keys from a signature', () => {
    const a1 = deriveStealthKeys(SIG_A);
    const a2 = deriveStealthKeys(SIG_A);
    expect(a1).toEqual(a2);
    expect(a1.spendingKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a1.viewingKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a1.spendingPub).toMatch(/^0x[0-9a-f]{66}$/); // compressed 33 bytes
    // Different signature, different keys.
    expect(deriveStealthKeys(SIG_B).spendingKey).not.toBe(a1.spendingKey);
  });

  it('the payer recognises a stealth address made for them, and the tag matches', () => {
    const keys = deriveStealthKeys(SIG_A);
    const ann = generateStealthAddress(keys, ('0x' + '11'.repeat(32)) as Hex);

    const found = checkStealthAddress({
      viewingKey: keys.viewingKey,
      spendingPub: keys.spendingPub,
      ephemeralPubKey: ann.ephemeralPubKey,
      viewTag: ann.viewTag,
    });
    expect(found).toBe(ann.stealthAddress);
  });

  it('the derived stealth private key actually controls the stealth address', () => {
    const keys = deriveStealthKeys(SIG_A);
    const ann = generateStealthAddress(keys, ('0x' + '22'.repeat(32)) as Hex);

    const stealthPriv = computeStealthPrivateKey({
      spendingKey: keys.spendingKey,
      viewingKey: keys.viewingKey,
      ephemeralPubKey: ann.ephemeralPubKey,
    });
    // The account of that private key must equal the announced stealth address.
    expect(privateKeyToAccount(stealthPriv).address).toBe(ann.stealthAddress);
  });

  it('a stranger with a different viewing key cannot recover the same address', () => {
    const mine = deriveStealthKeys(SIG_A);
    const theirs = deriveStealthKeys(SIG_B);
    const ann = generateStealthAddress(mine, ('0x' + '33'.repeat(32)) as Hex);

    // Wrong viewing key: even ignoring the tag, the recovered address differs.
    const wrong = checkStealthAddress({
      viewingKey: theirs.viewingKey,
      spendingPub: mine.spendingPub,
      ephemeralPubKey: ann.ephemeralPubKey,
    });
    expect(wrong).not.toBe(ann.stealthAddress);

    // And with the tag enforced it almost always rejects outright (1/256 collision).
    const tagged = checkStealthAddress({
      viewingKey: theirs.viewingKey,
      spendingPub: mine.spendingPub,
      ephemeralPubKey: ann.ephemeralPubKey,
      viewTag: ann.viewTag,
    });
    if (tagged !== null) expect(tagged).not.toBe(ann.stealthAddress);
  });

  it('each call yields a distinct one-time address (random ephemeral)', () => {
    const keys = deriveStealthKeys(SIG_A);
    const a = generateStealthAddress(keys);
    const b = generateStealthAddress(keys);
    expect(a.stealthAddress).not.toBe(b.stealthAddress);
    expect(a.ephemeralPubKey).not.toBe(b.ephemeralPubKey);
    // Both are still recognisably the payer's.
    for (const ann of [a, b]) {
      const found = checkStealthAddress({
        viewingKey: keys.viewingKey,
        spendingPub: keys.spendingPub,
        ephemeralPubKey: ann.ephemeralPubKey,
        viewTag: ann.viewTag,
      });
      expect(found).toBe(ann.stealthAddress);
    }
  });
});
