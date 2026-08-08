import { describe, expect, it } from 'vitest';
import type { Address, Hex, PublicClient } from 'viem';
import { AnnouncementIndex } from '../src/index.js';

/**
 * The index that lets a browser find its stealth boxes without reading the chain.
 *
 * What is tested here is the bookkeeping, because that is where a discovery index
 * fails quietly: a gap between the backfill and the first poll, a cursor that
 * advances past a failed read, a duplicate from a re-org. Each of those shows up
 * as a subscription that simply is not in the list, which on that screen is
 * indistinguishable from not having one.
 */

const ANNOUNCER = '0x1111111111111111111111111111111111111111' as Address;
const DEPLOY = 100n;

function announcement(n: number, block: bigint) {
  return {
    args: {
      stealthAddress: `0x${String(n).padStart(40, '0')}` as Address,
      ephemeralPubKey: `0x${String(n).padStart(66, '0')}` as Hex,
      metadata: `0x${String(n).padStart(64, '0')}` as Hex,
    },
    blockNumber: block,
  };
}

/**
 * A chain that answers a fixed head and returns whatever logs the test queued for
 * the range asked for. `calls` records the ranges, which is how a gap is caught.
 */
function fakeClient(script: {
  heads: bigint[];
  logsFor: (from: bigint, to: bigint) => ReturnType<typeof announcement>[];
  failGetLogs?: boolean;
}) {
  const calls: Array<{ from: bigint; to: bigint }> = [];
  let headIndex = 0;
  const client = {
    async getBlockNumber() {
      const h = script.heads[Math.min(headIndex, script.heads.length - 1)];
      headIndex++;
      return h as bigint;
    },
    async getContractEvents({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      calls.push({ from: fromBlock, to: toBlock });
      if (script.failGetLogs) throw new Error('rpc down');
      return script.logsFor(fromBlock, toBlock);
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe('AnnouncementIndex', () => {
  it('backfills from the deploy block and reports complete', async () => {
    const { client, calls } = fakeClient({
      heads: [200n],
      logsFor: () => [announcement(1, 150n)],
    });
    const index = new AnnouncementIndex(client, ANNOUNCER, DEPLOY, 10_000);
    await index.start();
    index.stop();

    expect(calls[0]).toEqual({ from: DEPLOY, to: 200n });
    const { announcements, head, complete } = index.since();
    expect(complete).toBe(true);
    expect(head).toBe('200');
    expect(announcements).toHaveLength(1);
  });

  it('does not report complete when the backfill fails', async () => {
    // A half-built index that claimed to be complete would have the client trust a
    // list with holes in it, and a missing box reads as "you have no subscription".
    const { client } = fakeClient({ heads: [200n], logsFor: () => [], failGetLogs: true });
    const index = new AnnouncementIndex(client, ANNOUNCER, DEPLOY, 10_000);
    await index.start();
    index.stop();
    expect(index.isReady()).toBe(false);
    expect(index.since().complete).toBe(false);
  });

  it('leaves no gap between the backfill and the first poll', async () => {
    // The head is read before the scan and the poll resumes at head+1. Reading it
    // after would let anything mined during the scan fall between the two ranges
    // and never be requested again, while `complete` already said true.
    const { client, calls } = fakeClient({
      heads: [200n, 260n],
      logsFor: (from) => (from === DEPLOY ? [announcement(1, 150n)] : [announcement(2, 240n)]),
    });
    const index = new AnnouncementIndex(client, ANNOUNCER, DEPLOY, 10_000);
    await index.start();
    // Drive one poll the way the timer would.
    await (index as unknown as { poll(): Promise<void> }).poll();
    index.stop();

    expect(calls).toEqual([
      { from: DEPLOY, to: 200n },
      { from: 201n, to: 260n },
    ]);
    expect(index.since().announcements).toHaveLength(2);
  });

  it('serves only what is new when asked from a cursor', async () => {
    const { client } = fakeClient({
      heads: [300n],
      logsFor: () => [announcement(1, 150n), announcement(2, 250n)],
    });
    const index = new AnnouncementIndex(client, ANNOUNCER, DEPLOY, 10_000);
    await index.start();
    index.stop();

    expect(index.since(0n).announcements).toHaveLength(2);
    expect(index.since(200n).announcements).toHaveLength(1);
    expect(index.since(200n).announcements[0]?.blockNumber).toBe('250');
    expect(index.since(999n).announcements).toHaveLength(0);
  });

  it('ignores a duplicate, so a re-org cannot list a box twice', async () => {
    const { client } = fakeClient({
      heads: [200n, 260n],
      // The same announcement comes back in the second range, as an overlapping
      // range or a re-org would produce.
      logsFor: () => [announcement(1, 150n)],
    });
    const index = new AnnouncementIndex(client, ANNOUNCER, DEPLOY, 10_000);
    await index.start();
    await (index as unknown as { poll(): Promise<void> }).poll();
    index.stop();
    expect(index.since().announcements).toHaveLength(1);
  });

  it('does not advance the cursor past a failed poll', async () => {
    // Advancing on failure would skip the range that errored, and the box
    // announced in it would be missing until the server restarted.
    let fail = false;
    const calls: Array<{ from: bigint; to: bigint }> = [];
    let headIndex = 0;
    const heads = [200n, 260n, 320n];
    const client = {
      async getBlockNumber() {
        return heads[Math.min(headIndex++, heads.length - 1)] as bigint;
      },
      async getContractEvents({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
        calls.push({ from: fromBlock, to: toBlock });
        if (fail) throw new Error('rpc down');
        return [];
      },
    } as unknown as PublicClient;

    const index = new AnnouncementIndex(client, ANNOUNCER, DEPLOY, 10_000);
    await index.start();
    fail = true;
    await (index as unknown as { poll(): Promise<void> }).poll();
    fail = false;
    await (index as unknown as { poll(): Promise<void> }).poll();
    index.stop();

    // The failed poll asked for 201..260; the next one starts at 201 again, not 261.
    expect(calls[1]).toEqual({ from: 201n, to: 260n });
    expect(calls[2]).toEqual({ from: 201n, to: 320n });
  });
});
