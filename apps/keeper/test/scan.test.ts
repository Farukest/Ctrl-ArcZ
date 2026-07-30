import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { OpenLedger } from '../src/scan.js';

const CONTRACT = '0x8dAb7148cdc31DAcad6d7e12161AA3DEDb572Dca' as const;
const SENDER = '0x46D060E22B84BFE396DF9CE61D5bA217ba6346C5' as const;

interface Emitted {
  eventName: string;
  block: bigint;
  args: Record<string, unknown>;
}

/**
 * A chain that only remembers which ranges were asked for. The point of these
 * tests is the request shape as much as the bookkeeping: an unbounded or
 * ever-widening range is the failure that once wedged the app's watcher, and it
 * is invisible until the RPC starts refusing.
 */
function fakeChain(events: Emitted[]) {
  const ranges: { from: bigint; to: bigint }[] = [];
  const client = {
    async getContractEvents({ eventName, fromBlock, toBlock }: {
      eventName: string;
      fromBlock: bigint;
      toBlock: bigint;
    }) {
      if (eventName === 'TransferCreated') ranges.push({ from: fromBlock, to: toBlock });
      return events
        .filter((e) => e.eventName === eventName && e.block >= fromBlock && e.block <= toBlock)
        .map((e) => ({ args: e.args }));
    },
  } as unknown as PublicClient;
  return { client, ranges };
}

const created = (id: bigint, block: bigint, deadline: number, amount = 1_000_000n): Emitted => ({
  eventName: 'TransferCreated',
  block,
  args: { transferId: id, sender: SENDER, amount, deadline: BigInt(deadline) },
});

const OPTS = { backfillBlocks: 1000, spanBlocks: 100 };

describe('OpenLedger', () => {
  it('picks up created transfers on the first backfill', async () => {
    const { client } = fakeChain([created(1n, 950n, 500)]);
    const ledger = new OpenLedger(CONTRACT);
    await ledger.sync(client, 1000n, OPTS);
    expect(ledger.size).toBe(1);
    expect(ledger.expired(1000, 10).map((t) => t.transferId)).toEqual([1n]);
  });

  it.each(['TransferClaimed', 'TransferCancelled', 'TransferReclaimed'])(
    'drops a transfer once %s settles it',
    async (eventName) => {
      const { client } = fakeChain([
        created(1n, 950n, 500),
        { eventName, block: 960n, args: { transferId: 1n } },
      ]);
      const ledger = new OpenLedger(CONTRACT);
      await ledger.sync(client, 1000n, OPTS);
      expect(ledger.size).toBe(0);
    },
  );

  it('keeps a locked transfer open — freezing must not strand the money', async () => {
    const { client } = fakeChain([
      created(1n, 950n, 500),
      { eventName: 'TransferLocked', block: 960n, args: { transferId: 1n } },
    ]);
    const ledger = new OpenLedger(CONTRACT);
    await ledger.sync(client, 1000n, OPTS);
    expect(ledger.size).toBe(1);
  });

  it('never widens its scan range after falling behind', async () => {
    // The watcher bug this guards: a tick that fails leaves the cursor where it
    // was, so the next request covers a bigger range, fails harder, and the range
    // grows every tick until the RPC refuses everything.
    const { client, ranges } = fakeChain([]);
    const ledger = new OpenLedger(CONTRACT);
    await ledger.sync(client, 1000n, OPTS); // backfill
    const afterBackfill = ledger.syncedTo!;

    // Head jumps 10,000 blocks ahead of where we are.
    await ledger.sync(client, afterBackfill + 10_000n, OPTS);

    const incremental = ranges[ranges.length - 1]!;
    expect(incremental.to - incremental.from + 1n).toBe(BigInt(OPTS.spanBlocks));
  });

  it('advances the cursor by what it actually scanned, not by where the head was', async () => {
    const { client } = fakeChain([]);
    const ledger = new OpenLedger(CONTRACT);
    await ledger.sync(client, 1000n, OPTS);
    await ledger.sync(client, 50_000n, OPTS);
    expect(ledger.syncedTo).toBe(1000n + BigInt(OPTS.spanBlocks));
  });

  it('catches up across successive ticks without losing a block or overshooting', async () => {
    const { client, ranges } = fakeChain([]);
    const ledger = new OpenLedger(CONTRACT);
    await ledger.sync(client, 1000n, OPTS);

    // Six bounded ticks to cover 600 blocks at 100 a tick. The point is that it
    // gets there in steps and stops exactly at the head, rather than issuing one
    // enormous request or running past it.
    for (let i = 0; i < 6; i++) await ledger.sync(client, 1600n, OPTS);
    expect(ledger.syncedTo).toBe(1600n);

    // Every incremental range starts exactly where the previous one ended, so no
    // block is scanned twice and none is skipped.
    const incremental = ranges.slice(1);
    for (let i = 1; i < incremental.length; i++) {
      expect(incremental[i]!.from).toBe(incremental[i - 1]!.to + 1n);
    }
    expect(incremental[incremental.length - 1]!.to).toBe(1600n);
  });

  it('does nothing when the head has not moved', async () => {
    const { client, ranges } = fakeChain([]);
    const ledger = new OpenLedger(CONTRACT);
    await ledger.sync(client, 1000n, OPTS);
    const before = ranges.length;
    await ledger.sync(client, 1000n, OPTS);
    expect(ranges.length).toBe(before);
  });

  it('returns the largest expired transfers first, capped', async () => {
    const { client } = fakeChain([
      created(1n, 950n, 500, 1_000_000n),
      created(2n, 951n, 500, 50_000_000n),
      created(3n, 952n, 500, 5_000_000n),
      created(4n, 953n, 9_999_999_999, 1_000_000n), // not expired
    ]);
    const ledger = new OpenLedger(CONTRACT);
    await ledger.sync(client, 1000n, OPTS);
    expect(ledger.expired(1000, 2).map((t) => t.transferId)).toEqual([2n, 3n]);
  });

  it('forgets a transfer on request', async () => {
    const { client } = fakeChain([created(1n, 950n, 500)]);
    const ledger = new OpenLedger(CONTRACT);
    await ledger.sync(client, 1000n, OPTS);
    ledger.forget(1n);
    expect(ledger.size).toBe(0);
  });
});
