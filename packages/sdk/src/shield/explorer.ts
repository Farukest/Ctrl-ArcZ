import { decodeEventLog, type Address, type Hex } from 'viem';
import { stealthAnnouncerAbi, spendPolicyFactoryAbi } from './abi.js';
import { EXPLORER_API_URL } from '../chains/arcTestnet.js';
import type { RawAnnouncement } from './stealthBox.js';

/**
 * Discovery through the chain's own explorer, which has already done the reading.
 *
 * `eth_getLogs` is queried by block range and Arc caps that range at 10,000, so
 * reading the announcer's 2.19 million blocks costs 219 requests no matter how few
 * events come back -- today, 219 requests to find nineteen records. That is a
 * property of the query shape, not of the data. Blockscout indexes by address and
 * pages by result, so the same nineteen records arrive in one request.
 *
 * The explorer is deliberately not the only path. Its API is not a contract we
 * hold anyone to, and the failure it can produce is the worst one this screen has:
 * a short list looks exactly like "you have no subscriptions". So everything here
 * either proves the list is whole or reports `complete: false`, and the caller
 * falls back to walking the chain, which is slower and cannot silently omit.
 *
 * No address is ever sent. The announcer list is undirected by design, and the
 * factory list is filtered for the caller's own `ownerHash` locally rather than as
 * a topic, so the explorer cannot tell which wallet is asking.
 */

/** How far behind the chain the explorer may be and still be trusted.
 *
 *  Arc produces about two blocks a second, so this is roughly two minutes. It is
 *  not a freshness guarantee: a box created seconds ago is already in the list
 *  because the creating client tracks it directly. What this catches is an
 *  explorer that has fallen materially behind, whose answer would be missing
 *  boxes rather than merely the newest one. */
export const EXPLORER_MAX_LAG_BLOCKS = 250n;

/** Enough for 2,000 records at Blockscout's 50-per-page. Past that the explorer is
 *  the wrong tool and the caller should read the chain rather than get a prefix. */
const MAX_PAGES = 40;

export interface ExplorerHealth {
  /** Blockscout's own word for "the historical backfill is done". */
  finished_indexing_blocks?: boolean;
  finished_indexing?: boolean;
  /** A decimal string, "1.00" when every block has been indexed. */
  indexed_blocks_ratio?: string;
}

/**
 * Whether the explorer's self-reported state permits trusting a log list from it.
 *
 * Two separate failures, and both have to be excluded. An explorer still filling
 * in old blocks is missing history, which never heals on its own from the user's
 * side and reads as an empty list. An explorer lagging at the tip is merely stale,
 * which the next refresh fixes, but past a point stale becomes missing.
 */
export function explorerUsable(
  health: ExplorerHealth | null,
  explorerHead: bigint | null,
  chainHead: bigint | null,
  maxLag: bigint = EXPLORER_MAX_LAG_BLOCKS,
): boolean {
  if (!health) return false;
  if (health.finished_indexing_blocks !== true) return false;
  const ratio = Number.parseFloat(health.indexed_blocks_ratio ?? '0');
  if (!Number.isFinite(ratio) || ratio < 1) return false;
  // An unknown head is not a small lag; it is no answer, and it is treated as one.
  if (explorerHead === null || chainHead === null) return false;
  if (explorerHead >= chainHead) return true;
  return chainHead - explorerHead <= maxLag;
}

export interface ExplorerLog {
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
}

type Fetcher = typeof fetch;

interface RawLogPage {
  items?: Array<{ topics?: (string | null)[]; data?: string; block_number?: number }>;
  next_page_params?: Record<string, string | number> | null;
}

async function getJson<T>(url: string, f: Fetcher): Promise<T | null> {
  try {
    const res = await f(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface ExplorerOptions {
  apiUrl?: string;
  fetchImpl?: Fetcher;
  maxLag?: bigint;
}

interface ExplorerState {
  health: ExplorerHealth | null;
  head: bigint | null;
}

/**
 * Held briefly, because a screen asks this twice in a row.
 *
 * Discovery reads two contracts and each read has to establish that the explorer
 * can be believed, which was six requests to answer one question. Ten seconds is
 * far inside the lag this guard tolerates (250 blocks, about two minutes), so a
 * cached answer cannot wave through an explorer that a fresh one would refuse.
 * Only a usable state is kept: a failure has to be retried, not remembered.
 */
const STATE_TTL_MS = 10_000;
const stateCache = new Map<string, { at: number; state: ExplorerState }>();

/** The explorer's health and its own head, in one round trip each. */
async function explorerState(apiUrl: string, f: Fetcher): Promise<ExplorerState> {
  const hit = stateCache.get(apiUrl);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.state;

  const [health, blocks] = await Promise.all([
    getJson<ExplorerHealth>(`${apiUrl}/main-page/indexing-status`, f),
    getJson<{ items?: Array<{ height?: number }> }>(`${apiUrl}/blocks?type=block`, f),
  ]);
  const height = blocks?.items?.[0]?.height;
  const state: ExplorerState = { health, head: typeof height === 'number' ? BigInt(height) : null };
  if (state.health && state.head !== null) stateCache.set(apiUrl, { at: Date.now(), state });
  return state;
}

/** Forget the cached health, for tests and for a hard reset. */
export function clearExplorerState(): void {
  stateCache.clear();
}

/**
 * Every log a contract has emitted, oldest first.
 *
 * `complete` is false on any doubt at all: a failed request, a page limit reached,
 * an explorer that is behind or still indexing. A caller must not distinguish
 * "false because the network blipped" from "false because there is nothing" --
 * both mean read the chain.
 */
export async function explorerLogs(
  address: Address,
  chainHead: bigint | null,
  opts: ExplorerOptions = {},
): Promise<{ logs: ExplorerLog[]; complete: boolean }> {
  const apiUrl = opts.apiUrl ?? EXPLORER_API_URL;
  const f = opts.fetchImpl ?? fetch;

  const { health, head } = await explorerState(apiUrl, f);
  if (!explorerUsable(health, head, chainHead, opts.maxLag)) return { logs: [], complete: false };

  const logs: ExplorerLog[] = [];
  let query = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson<RawLogPage>(`${apiUrl}/addresses/${address}/logs${query}`, f);
    if (!body) return { logs: [], complete: false };
    for (const item of body.items ?? []) {
      const topics = (item.topics ?? []).filter((t): t is string => typeof t === 'string');
      if (topics.length === 0 || typeof item.block_number !== 'number') continue;
      logs.push({
        topics: topics as Hex[],
        data: (item.data ?? '0x') as Hex,
        blockNumber: BigInt(item.block_number),
      });
    }
    const next = body.next_page_params;
    if (!next) {
      // Blockscout serves newest first; block order is the only honest order here.
      logs.reverse();
      return { logs, complete: true };
    }
    query = `?${new URLSearchParams(
      Object.entries(next).map(([k, v]) => [k, String(v)]),
    ).toString()}`;
  }
  // Ran out of pages before running out of logs. A prefix is not an answer.
  return { logs: [], complete: false };
}

/** Stealth announcements from the explorer, in the shape `recognizeAnnouncements`
 *  takes. Recognition still happens on the caller's device, with the viewing key
 *  that never leaves it. */
export async function explorerAnnouncements(
  announcer: Address,
  chainHead: bigint | null,
  opts: ExplorerOptions = {},
): Promise<{ announcements: RawAnnouncement[]; complete: boolean }> {
  const { logs, complete } = await explorerLogs(announcer, chainHead, opts);
  if (!complete) return { announcements: [], complete: false };

  const announcements: RawAnnouncement[] = [];
  for (const log of logs) {
    try {
      const { eventName, args } = decodeEventLog({
        abi: stealthAnnouncerAbi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (eventName !== 'Announcement') continue;
      const a = args as unknown as {
        stealthAddress?: Address;
        ephemeralPubKey?: Hex;
        metadata?: Hex;
      };
      if (!a.stealthAddress || !a.ephemeralPubKey || !a.metadata) continue;
      announcements.push({
        stealthAddress: a.stealthAddress,
        ephemeralPubKey: a.ephemeralPubKey,
        metadata: a.metadata,
      });
    } catch {
      // Not an announcement, or not one this ABI knows. Skipping it cannot hide a
      // box: an announcement we cannot decode is one we could not have used.
      continue;
    }
  }
  return { announcements, complete: true };
}

export interface CreatedAccount {
  account: Address;
  ownerHash: Hex;
  salt: Hex;
}

/**
 * Boxes the factory has created, all of them, for the caller to filter.
 *
 * The chain path sends `ownerHash` as a topic, which hands the node a selector it
 * can check against any guessed address. Here the whole list comes back and the
 * match happens locally, so the explorer learns nothing about who is asking.
 */
export async function explorerAccountsCreated(
  factory: Address,
  chainHead: bigint | null,
  opts: ExplorerOptions = {},
): Promise<{ accounts: CreatedAccount[]; complete: boolean }> {
  const { logs, complete } = await explorerLogs(factory, chainHead, opts);
  if (!complete) return { accounts: [], complete: false };

  const accounts: CreatedAccount[] = [];
  for (const log of logs) {
    try {
      const { eventName, args } = decodeEventLog({
        abi: spendPolicyFactoryAbi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (eventName !== 'AccountCreated') continue;
      const a = args as unknown as { account?: Address; ownerHash?: Hex; salt?: Hex };
      if (!a.account || !a.ownerHash) continue;
      accounts.push({ account: a.account, ownerHash: a.ownerHash, salt: a.salt ?? ('0x' as Hex) });
    } catch {
      continue;
    }
  }
  return { accounts, complete: true };
}
