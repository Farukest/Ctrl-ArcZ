import { BlockscoutDataProvider, CachingDataProvider } from '@ctrl-arcz/sdk';

/**
 * One risk data provider for the whole session, with the sender's counterparty
 * scan cached.
 *
 * The firewall runs on every debounced keystroke, and the part of it that costs
 * real time is walking the sender's outgoing history through the indexer — ten
 * pages at several seconds each for a wallet with any real usage. Without a cache
 * the first verdict took nearly half a minute here, and so did the next address
 * the user tried. The scan result only changes when the sender pays someone new,
 * which does not happen between two keystrokes.
 *
 * Failures and incomplete scans are deliberately not cached, so the firewall
 * still fails closed when the indexer is down.
 */
const provider = new CachingDataProvider(new BlockscoutDataProvider(), { ttlMs: 60_000 });

export function riskProvider(): CachingDataProvider {
  return provider;
}

/** Drop the cache when the connected wallet changes — a different sender has a
 *  different counterparty set, and serving one wallet's from another's would be
 *  the exact mistake the lookalike rule exists to prevent. */
export function clearRiskCache(): void {
  provider.clear();
}
