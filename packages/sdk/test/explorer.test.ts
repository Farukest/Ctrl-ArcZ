import { beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  clearExplorerState,
  explorerAnnouncements,
  explorerLogs,
  explorerUsable,
} from '../src/index.js';

beforeEach(() => clearExplorerState());

/**
 * Discovery through the chain's explorer.
 *
 * Everything tested here is about one failure: returning a list that is short
 * without saying so. On the subscriptions screen a missing box is indistinguishable
 * from not having one, so every doubt has to surface as `complete: false` and send
 * the caller to the chain. The happy path is the easy part; these are the ways the
 * explorer can quietly be wrong.
 */

const ANNOUNCER = '0x9b9F9F8b98Dd7a74889725e79591B3E69BdC991D' as Address;
const HEALTHY = { finished_indexing_blocks: true, indexed_blocks_ratio: '1.00' };

/** A real Announcement log, as Blockscout serves it. */
function announcementLog(block: number, stealth: string) {
  return {
    topics: [
      // Announcement(uint256 indexed,address indexed,address indexed,bytes,bytes)
      '0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7',
      `0x${'0'.repeat(63)}1`,
      `0x${'0'.repeat(24)}${stealth.slice(2)}`,
      `0x${'0'.repeat(24)}${'aa'.repeat(20)}`,
    ],
    // Two dynamic `bytes`: offsets, then each length-prefixed and padded.
    data:
      '0x' +
      '40'.padStart(64, '0') +
      '80'.padStart(64, '0') +
      '01'.padStart(64, '0') +
      'ff'.padEnd(64, '0') +
      '01'.padStart(64, '0') +
      'ee'.padEnd(64, '0'),
    block_number: block,
  };
}

/** Serves scripted pages; `calls` records every URL so paging can be asserted. */
function fakeExplorer(script: {
  health?: unknown;
  head?: number | null;
  pages?: Array<{ items: unknown[]; next_page_params: Record<string, string> | null }>;
  failLogs?: boolean;
}) {
  const calls: string[] = [];
  let page = 0;
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
    if (String(url).includes('indexing-status')) {
      return script.health === undefined ? ok(HEALTHY) : ok(script.health);
    }
    if (String(url).includes('/blocks')) {
      return ok({ items: script.head === null ? [] : [{ height: script.head ?? 1_000 }] });
    }
    if (script.failLogs) return { ok: false, json: async () => ({}) } as unknown as Response;
    const p = script.pages?.[page++] ?? { items: [], next_page_params: null };
    return ok(p);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('explorerUsable', () => {
  it('accepts a finished index at the head', () => {
    expect(explorerUsable(HEALTHY, 1_000n, 1_000n)).toBe(true);
  });

  it('refuses while the historical backfill is unfinished', () => {
    // The dangerous one: the explorer is at the tip but missing old blocks, so a
    // box from last week is absent and nothing about the answer says so.
    expect(
      explorerUsable({ finished_indexing_blocks: false, indexed_blocks_ratio: '0.92' }, 1_000n, 1_000n),
    ).toBe(false);
    expect(
      explorerUsable({ finished_indexing_blocks: true, indexed_blocks_ratio: '0.99' }, 1_000n, 1_000n),
    ).toBe(false);
  });

  it('accepts a small lag and refuses a large one', () => {
    expect(explorerUsable(HEALTHY, 900n, 1_000n, 250n)).toBe(true);
    expect(explorerUsable(HEALTHY, 700n, 1_000n, 250n)).toBe(false);
  });

  it('accepts an explorer ahead of the head we read', () => {
    // Our own head came from a different node; being ahead is not a fault.
    expect(explorerUsable(HEALTHY, 1_010n, 1_000n)).toBe(true);
  });

  it('treats an unknown head as no answer, not as no lag', () => {
    expect(explorerUsable(HEALTHY, null, 1_000n)).toBe(false);
    expect(explorerUsable(HEALTHY, 1_000n, null)).toBe(false);
    expect(explorerUsable(null, 1_000n, 1_000n)).toBe(false);
  });
});

describe('explorerLogs', () => {
  it('returns every page, oldest first', async () => {
    const { fetchImpl, calls } = fakeExplorer({
      pages: [
        { items: [announcementLog(300, `0x${'33'.repeat(20)}`)], next_page_params: { index: '7' } },
        { items: [announcementLog(100, `0x${'11'.repeat(20)}`)], next_page_params: null },
      ],
    });
    const { logs, complete } = await explorerLogs(ANNOUNCER, 1_000n, { fetchImpl });
    expect(complete).toBe(true);
    expect(logs.map((l) => l.blockNumber)).toEqual([100n, 300n]);
    expect(calls.some((c) => c.includes('index=7'))).toBe(true);
  });

  it('reports incomplete when the log request fails', async () => {
    const { fetchImpl } = fakeExplorer({ failLogs: true });
    const { logs, complete } = await explorerLogs(ANNOUNCER, 1_000n, { fetchImpl });
    expect(complete).toBe(false);
    expect(logs).toEqual([]);
  });

  it('does not ask for logs at all when the index is behind', async () => {
    // No point paging an explorer whose answer would not be trusted, and the
    // request itself is one more thing that can be observed.
    const { fetchImpl, calls } = fakeExplorer({ head: 100 });
    const { complete } = await explorerLogs(ANNOUNCER, 100_000n, { fetchImpl });
    expect(complete).toBe(false);
    expect(calls.some((c) => c.includes('/logs'))).toBe(false);
  });

  it('never sends an address it was not asked to look up', async () => {
    const { fetchImpl, calls } = fakeExplorer({ pages: [{ items: [], next_page_params: null }] });
    await explorerLogs(ANNOUNCER, 1_000n, { fetchImpl });
    // The announcer itself is the path; no topic filter, no wallet, no ownerHash.
    for (const c of calls) {
      expect(c.includes('topic')).toBe(false);
      expect(c.toLowerCase().includes('ownerhash')).toBe(false);
    }
  });

  it('establishes trust once for two reads in a row', async () => {
    // Discovery reads the announcer and the factory back to back. Proving the
    // explorer is believable twice cost four requests to answer nothing new.
    const { fetchImpl, calls } = fakeExplorer({
      pages: [
        { items: [], next_page_params: null },
        { items: [], next_page_params: null },
      ],
    });
    await explorerLogs(ANNOUNCER, 1_000n, { fetchImpl });
    await explorerLogs(ANNOUNCER, 1_000n, { fetchImpl });
    expect(calls.filter((c) => c.includes('indexing-status'))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('/logs'))).toHaveLength(2);
  });

  it('does not remember a state it could not read', async () => {
    // Caching a failure would keep the explorer written off for ten seconds over
    // one dropped request, and send everyone to the chain in the meantime.
    const failing = fakeExplorer({ health: null, head: null });
    await explorerLogs(ANNOUNCER, 1_000n, { fetchImpl: failing.fetchImpl });
    await explorerLogs(ANNOUNCER, 1_000n, { fetchImpl: failing.fetchImpl });
    expect(failing.calls.filter((c) => c.includes('indexing-status'))).toHaveLength(2);
  });

  it('gives up rather than return a prefix when the pages never end', async () => {
    // A next_page_params that always points onward would otherwise be followed
    // forever, or truncated silently. Truncated silently is the one to avoid.
    const fetchImpl = (async (url: string) => {
      const ok = (b: unknown) => ({ ok: true, json: async () => b }) as unknown as Response;
      if (String(url).includes('indexing-status')) return ok(HEALTHY);
      if (String(url).includes('/blocks')) return ok({ items: [{ height: 1_000 }] });
      return ok({ items: [announcementLog(1, `0x${'11'.repeat(20)}`)], next_page_params: { index: '1' } });
    }) as unknown as typeof fetch;
    const { logs, complete } = await explorerLogs(ANNOUNCER, 1_000n, { fetchImpl });
    expect(complete).toBe(false);
    expect(logs).toEqual([]);
  });
});

describe('explorerAnnouncements', () => {
  it('decodes what it fetched', async () => {
    const stealth = `0x${'11'.repeat(20)}`;
    const { fetchImpl } = fakeExplorer({
      pages: [{ items: [announcementLog(100, stealth)], next_page_params: null }],
    });
    const { announcements, complete } = await explorerAnnouncements(ANNOUNCER, 1_000n, { fetchImpl });
    expect(complete).toBe(true);
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.stealthAddress.toLowerCase()).toBe(stealth);
    expect(announcements[0]?.ephemeralPubKey).toBe('0xff');
    expect(announcements[0]?.metadata).toBe('0xee');
  });

  it('returns nothing and says so when the source is not trusted', async () => {
    const { fetchImpl } = fakeExplorer({ health: { finished_indexing_blocks: false } });
    const { announcements, complete } = await explorerAnnouncements(ANNOUNCER, 1_000n, { fetchImpl });
    expect(complete).toBe(false);
    expect(announcements).toEqual([]);
  });

  it('skips a log it cannot decode without calling the list short', async () => {
    const { fetchImpl } = fakeExplorer({
      pages: [
        {
          items: [
            { topics: [`0x${'99'.repeat(32)}`], data: '0x', block_number: 50 },
            announcementLog(100, `0x${'11'.repeat(20)}`),
          ],
          next_page_params: null,
        },
      ],
    });
    const { announcements, complete } = await explorerAnnouncements(ANNOUNCER, 1_000n, { fetchImpl });
    expect(complete).toBe(true);
    expect(announcements).toHaveLength(1);
  });
});
