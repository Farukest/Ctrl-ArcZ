import type { Address } from 'viem';

/**
 * Everyone this wallet has completed a protected transfer to, from the server's
 * index.
 *
 * The browser used to answer this by scanning `RecipientVerified` over a fixed
 * 200,000-block window. That looked generous and was not: Arc produces roughly
 * two blocks a second, so the window covered a bit over a day. Anyone paid
 * before that fell out of the set, and with them went the lookalike rule's
 * protection — the firewall would happily wave through an imitation of a
 * counterparty from yesterday. The server keeps an index backfilled from the
 * deploy block, so this has no window at all.
 *
 * Cached per sender for the session: the set only grows, and only when the user
 * completes a transfer, which the app already knows about.
 */

let cache: { sender: string; recipients: Address[]; complete: boolean } | null = null;

export async function verifiedRecipients(
  sender: Address,
  chainId: number,
): Promise<{ recipients: Address[]; complete: boolean }> {
  // Keyed by chain as well as sender. The same address has a different set of
  // people it has paid on every network, and serving one for the other is what
  // the lookalike rule compares against -- it would call a stranger familiar.
  const key = `${chainId}:${sender.toLowerCase()}`;
  if (cache && cache.sender === key) {
    return { recipients: cache.recipients, complete: cache.complete };
  }
  try {
    const res = await fetch(`/api/verified-recipients?sender=${sender}&chainId=${chainId}`);
    if (!res.ok) return { recipients: [], complete: false };
    const body = (await res.json()) as { recipients?: Address[]; complete?: boolean };
    const value = {
      sender: key,
      recipients: body.recipients ?? [],
      complete: Boolean(body.complete),
    };
    // Only a complete index is worth remembering. A partial one means the server
    // is still backfilling, and caching it would freeze a half-built set.
    if (value.complete) cache = value;
    return { recipients: value.recipients, complete: value.complete };
  } catch {
    // Unreachable. Returning `complete: false` keeps the firewall failing closed
    // rather than pretending the sender has never paid anyone.
    return { recipients: [], complete: false };
  }
}

/** Forget the cache — after a wallet change, or after a transfer settles. */
export function clearVerifiedRecipients(): void {
  cache = null;
}
