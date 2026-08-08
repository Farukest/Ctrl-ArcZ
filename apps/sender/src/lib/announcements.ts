import type { Hex } from 'viem';
import type { RawAnnouncement } from '@ctrl-arcz/sdk';

/**
 * Every stealth announcement, from the server's index instead of the chain.
 *
 * The browser used to read this itself: the announcer has no owner tag by design,
 * so finding your own boxes means testing every announcement ever made, and that
 * was 2.16 million blocks, 217 chunked `eth_getLogs` calls, on every visit to the
 * tab. Worse, it grew: Arc produces about nineteen blocks a second, so the wait
 * got roughly half a minute longer every day. The server keeps an index that
 * backfilled once and follows the chain, so this is one request.
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
let cache: { entries: RawAnnouncement[]; head: bigint } | null = null;

export async function fetchAnnouncements(): Promise<AnnouncementFeed> {
  try {
    // Ask only for what is new. On a revisit that is almost always nothing.
    const from = cache ? cache.head + 1n : 0n;
    const res = await fetch(`/api/announcements?fromBlock=${from.toString()}`);
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
    if (body.head) cache = { entries, head: BigInt(body.head) };
    return { announcements: entries, complete: true };
  } catch {
    return { announcements: cache?.entries ?? [], complete: false };
  }
}

/** Forget the list. Nothing here is wallet-specific, so this is only for tests
 *  and for a hard reset. */
export function clearAnnouncements(): void {
  cache = null;
}
