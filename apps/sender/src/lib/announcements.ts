import type { Hex } from 'viem';
import {
  ARC_TESTNET_CHAIN_ID,
  deploymentFor,
  explorerAnnouncements,
  type RawAnnouncement,
} from '@ctrl-arcz/sdk';
import { bridgeClients, getPublicClient } from '@ctrl-arcz/demo-kit';

/**
 * A read client for one chain, without a session to hand.
 *
 * This module is called from a hook that has the chain id but not the wallet, and
 * the only use is `getBlockNumber`, which needs no account. Arc goes through our
 * own RPCs; elsewhere the wallet's provider answers for the chain it is on.
 */
function readClientForChain(chainId: number) {
  return chainId === ARC_TESTNET_CHAIN_ID
    ? getPublicClient()
    : bridgeClients(chainId, '0x0000000000000000000000000000000000000000').publicClient;
}


/**
 * Every stealth announcement, without reading the chain window by window.
 *
 * The browser used to do that itself: the announcer has no owner tag by design, so
 * finding your own boxes means testing every announcement ever made, and that was
 * 2.19 million blocks, 219 chunked `eth_getLogs` calls, on every visit to the tab.
 * The cost is the query shape, not the data -- 219 requests to find nineteen
 * records -- and it only grows, by about 168,000 blocks a day.
 *
 * Two sources answer it in one request instead, tried in order:
 *
 * 1. Our own index, which backfilled once and follows the chain. It reports the
 *    head it is complete to, so "complete" is something it knows rather than
 *    something we infer.
 * 2. The chain's explorer, which indexed all of this before we existed. Second
 *    rather than first because its API is not a contract anyone owes us: if the
 *    schema moves, it fails, and the failure it produces is a short list. It earns
 *    its place by being up when our server is not.
 *
 * Neither is trusted without proof of completeness, and when both decline the
 * caller reads the chain. Slow is an acceptable answer here; short is not.
 *
 * **The viewing key stays here.** This fetches the same public list for everybody
 * and `recognizeAnnouncements` matches it locally. That is the whole reason the
 * endpoint takes no address: the server can serve discovery without being able to
 * perform it, so it never learns which box belongs to whom. An endpoint that
 * accepted a viewing key would be one line shorter and would hand away the
 * property the stealth addresses exist for.
 */
export interface AnnouncementFeed {
  announcements: RawAnnouncement[];
  /**
   * False when the server is still backfilling, or unreachable. The caller must
   * then read the chain itself: a partial list is indistinguishable from "you have
   * no subscriptions", and quietly showing an empty list is the one answer this
   * screen must never give wrongly.
   */
  complete: boolean;
}

interface Wire {
  stealthAddress?: string;
  ephemeralPubKey?: string;
  metadata?: string;
  blockNumber?: string;
}

/**
 * Cached for the session, and only ever extended.
 *
 * Public data with no link to this wallet, unlike the recognised boxes, which is
 * why this may be held at all. Memory anyway, because the saving is a few seconds
 * and the list is cheap to refetch; see `useSubscriptions` for why the recognised
 * boxes specifically must not reach browser storage.
 */
/**
 * Per chain. The announcer is a different contract on each, so one cursor and one
 * list across all of them would hand a wallet another network's boxes -- which it
 * would then fail to recognise, or worse, recognise by coincidence of key reuse.
 */
const caches = new Map<number, { entries: RawAnnouncement[]; head: bigint }>();

export async function fetchAnnouncements(chainId: number): Promise<AnnouncementFeed> {
  // Nothing is announced on a chain we have no announcer on. Asking anyway meant a
  // request the server had to refuse, twice per visit, logged as a console error on
  // a screen that was already telling the user the feature is unavailable here.
  if (!deploymentFor(chainId)) return { announcements: [], complete: true };
  const own = await fetchFromIndex(chainId);
  if (own.complete) return own;
  return fetchFromExplorer(chainId);
}

/**
 * The explorer's copy, whole or not at all.
 *
 * Not cached against `cache`: that cursor belongs to our index's head, and mixing
 * a second source into it would make an incremental request ask for a range the
 * other source never covered. The explorer returns everything anyway, so there is
 * nothing to save.
 */
async function fetchFromExplorer(chainId: number): Promise<AnnouncementFeed> {
  const cache = caches.get(chainId);
  const deployment = deploymentFor(chainId);
  // No explorer on this chain, so this fallback has nothing to fall back to.
  // Incomplete is the honest answer and the caller already handles it by reading
  // the chain itself.
  if (!deployment?.explorerApi) {
    return { announcements: cache?.entries ?? [], complete: false };
  }
  try {
    const head = await readClientForChain(chainId).getBlockNumber();
    const { announcements, complete } = await explorerAnnouncements(
      deployment.stealthAnnouncer,
      head,
      { apiUrl: deployment.explorerApi },
    );
    if (!complete) return { announcements: cache?.entries ?? [], complete: false };
    return { announcements, complete: true };
  } catch {
    return { announcements: caches.get(chainId)?.entries ?? [], complete: false };
  }
}

async function fetchFromIndex(chainId: number): Promise<AnnouncementFeed> {
  const cache = caches.get(chainId);
  try {
    // Ask only for what is new. On a revisit that is almost always nothing.
    const from = cache ? cache.head + 1n : 0n;
    const res = await fetch(
      `/api/announcements?fromBlock=${from.toString()}&chainId=${chainId}`,
    );
    if (!res.ok) return { announcements: cache?.entries ?? [], complete: false };
    const body = (await res.json()) as {
      announcements?: Wire[];
      head?: string | null;
      complete?: boolean;
    };
    if (!body.complete) {
      // Do not cache a half-built index, and do not let the caller trust it.
      return { announcements: cache?.entries ?? [], complete: false };
    }

    const fresh: RawAnnouncement[] = (body.announcements ?? [])
      .filter((a) => a.stealthAddress && a.ephemeralPubKey && a.metadata)
      .map((a) => ({
        stealthAddress: a.stealthAddress as `0x${string}`,
        ephemeralPubKey: a.ephemeralPubKey as Hex,
        metadata: a.metadata as Hex,
      }));

    const entries = [...(cache?.entries ?? []), ...fresh];
    // Advance the cursor only alongside the entries it covers, so a dropped
    // response can never leave a block range that is never asked for again.
    if (body.head) caches.set(chainId, { entries, head: BigInt(body.head) });
    return { announcements: entries, complete: true };
  } catch {
    return { announcements: cache?.entries ?? [], complete: false };
  }
}

/** Forget the list. Nothing here is wallet-specific, so this is only for tests
 *  and for a hard reset. */
export function clearAnnouncements(): void {
  caches.clear();
}
