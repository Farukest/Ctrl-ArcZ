import { describe, expect, it } from 'vitest';
import type { Address, Hex, PublicClient } from 'viem';
import { AccountOwnerIndex } from '../src/shield/accountOwnerIndex.js';

const FACTORY = '0x00000000000000000000000000000000000000fa' as Address;
const BOX1 = '0x0000000000000000000000000000000000000b01' as Address;
const BOX2 = '0x0000000000000000000000000000000000000b02' as Address;
const OH1 = ('0x' + '11'.repeat(32)) as Hex;
const OH2 = ('0x' + '22'.repeat(32)) as Hex;
const UNKNOWN = '0x0000000000000000000000000000000000000bff' as Address;

// A head just above the deploy block so the backfill is a single chunk, and one
// page of AccountCreated events.
function mockClient(logs: Array<{ args: { account?: Address; ownerHash?: Hex } }>): PublicClient {
  return {
    getBlockNumber: async () => 51_331_000n,
    getContractEvents: async () => logs,
  } as unknown as PublicClient;
}

describe('AccountOwnerIndex', () => {
  it('maps each box to the ownerHash it was created under, and returns null for an unknown box', async () => {
    const idx = new AccountOwnerIndex(
      mockClient([
        { args: { account: BOX1, ownerHash: OH1 } },
        { args: { account: BOX2, ownerHash: OH2 } },
      ]),
      FACTORY,
      51_330_000n, // deploy block, just below head -> one chunk
      1_000_000, // long poll; stop() before it fires
    );
    await idx.start();
    idx.stop();

    // This is what the co-signer's owner-bind relies on: a box it has seen resolves
    // to its ownerHash, and a box it has not seen resolves to null (fail closed).
    expect(idx.isReady()).toBe(true);
    expect(idx.ownerHashOf(BOX1)).toBe(OH1);
    expect(idx.ownerHashOf(BOX2)).toBe(OH2);
    expect(idx.ownerHashOf(BOX1.toUpperCase() as Address)).toBe(OH1); // case-insensitive
    expect(idx.ownerHashOf(UNKNOWN)).toBeNull();
  });

  it('is not ready before start, so the co-signer fails closed rather than guessing', () => {
    const idx = new AccountOwnerIndex(mockClient([]), FACTORY, 51_330_000n, 1_000_000);
    expect(idx.isReady()).toBe(false);
    expect(idx.ownerHashOf(BOX1)).toBeNull();
    idx.stop();
  });
});
