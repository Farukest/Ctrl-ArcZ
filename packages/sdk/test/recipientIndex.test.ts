import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { VerifiedRecipientIndex } from '../src/risk/recipientIndex.js';
import { CTRL_ARCZ_ADDRESS } from '../src/chains/arcTestnet.js';

const SENDER = '0x00000000000000000000000000000000000000a1' as Address;
const R1 = '0x00000000000000000000000000000000000000b1' as Address;
const R2 = '0x00000000000000000000000000000000000000b2' as Address;
const OTHER = '0x0000000000000000000000000000000000000099' as Address;

// Minimal client: a fixed head just above the deploy block, and one page of events.
function mockClient(logs: Array<{ args: { sender?: Address; recipient?: Address } }>): PublicClient {
  return {
    getBlockNumber: async () => 51_331_000n,
    getContractEvents: async () => logs,
  } as unknown as PublicClient;
}

describe('VerifiedRecipientIndex', () => {
  it('indexes RecipientVerified by sender and answers instantly, deduped', async () => {
    const idx = new VerifiedRecipientIndex(
      mockClient([
        { args: { sender: SENDER, recipient: R1 } },
        { args: { sender: SENDER, recipient: R2 } },
        { args: { sender: SENDER, recipient: R1 } }, // duplicate
      ]),
      CTRL_ARCZ_ADDRESS,
      1_000_000, // long poll; we stop() before it fires
    );
    await idx.start();
    idx.stop();

    const got = idx.recipientsOf(SENDER).map((a) => a.toLowerCase());
    expect(got).toContain(R1.toLowerCase());
    expect(got).toContain(R2.toLowerCase());
    expect(got.length).toBe(2); // deduped
    expect(idx.recipientsOf(OTHER)).toEqual([]); // unknown sender -> empty, no RPC
  });
});
