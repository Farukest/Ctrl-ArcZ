import { describe, expect, it } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { deriveStealthKeys, generateStealthAddress } from '../src/shield/stealth.js';
import {
  newStealthOwner,
  announceArgsFor,
  recognizeAnnouncements,
  encodeStealthMetadata,
  decodeStealthMetadata,
  type RawAnnouncement,
} from '../src/shield/stealthBox.js';

const SIG_A =
  '0x9a8be0e7f2b1c4d6e8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f701b' as Hex;
const SIG_B =
  '0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff001b' as Hex;
const BOX = getAddress('0x00000000000000000000000000000000cafebabe');

describe('stealth box announcements', () => {
  it('round-trips the box address through metadata', () => {
    expect(decodeStealthMetadata(encodeStealthMetadata(BOX))).toBe(BOX);
  });

  it('newStealthOwner + announceArgsFor produce args the owner can recognise', () => {
    const keys = deriveStealthKeys(SIG_A);
    const stealth = newStealthOwner(keys, ('0x' + 'ab'.repeat(32)) as Hex);
    const announceArgs = announceArgsFor(stealth, BOX);
    const [schemeId, annStealth, ephemeralPubKey, metadata] = announceArgs;

    expect(schemeId).toBe(1n);
    expect(annStealth).toBe(stealth.stealthAddress);

    const mine = recognizeAnnouncements(keys, [{ stealthAddress: annStealth, ephemeralPubKey, metadata }]);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.box).toBe(BOX);
    expect(mine[0]!.stealthAddress).toBe(stealth.stealthAddress);
  });

  it('recognises only the owner’s announcements in a mixed batch', () => {
    const me = deriveStealthKeys(SIG_A);
    const other = deriveStealthKeys(SIG_B);

    const mineAnn = generateStealthAddress(me, ('0x' + '01'.repeat(32)) as Hex);
    const otherAnn = generateStealthAddress(other, ('0x' + '02'.repeat(32)) as Hex);

    const batch: RawAnnouncement[] = [
      { stealthAddress: mineAnn.stealthAddress, ephemeralPubKey: mineAnn.ephemeralPubKey, metadata: encodeStealthMetadata(BOX) },
      { stealthAddress: otherAnn.stealthAddress, ephemeralPubKey: otherAnn.ephemeralPubKey, metadata: encodeStealthMetadata(BOX) },
    ];

    const mine = recognizeAnnouncements(me, batch);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.stealthAddress).toBe(mineAnn.stealthAddress);

    // The other party sees exactly their own one, not mine.
    const theirs = recognizeAnnouncements(other, batch);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.stealthAddress).toBe(otherAnn.stealthAddress);
  });

  it('drops malformed announcements without throwing', () => {
    const keys = deriveStealthKeys(SIG_A);
    const junk: RawAnnouncement[] = [
      { stealthAddress: BOX, ephemeralPubKey: '0xdead' as Hex, metadata: '0x' as Hex },
    ];
    expect(() => recognizeAnnouncements(keys, junk)).not.toThrow();
    expect(recognizeAnnouncements(keys, junk)).toHaveLength(0);
  });
});
