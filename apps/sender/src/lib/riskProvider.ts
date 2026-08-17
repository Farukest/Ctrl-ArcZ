import { BlockscoutDataProvider, CachingDataProvider, deploymentFor } from '@ctrl-arcz/sdk';

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
/**
 * One provider per chain.
 *
 * A recipient's history is a fact about one network. Reading Arc's for a payment
 * on Base does not fail, it answers a different question -- and the firewall
 * believes the answer, which is worse than having none.
 */
const providers = new Map<number, CachingDataProvider>();

export function riskProvider(chainId: number): CachingDataProvider {
  const cached = providers.get(chainId);
  if (cached) return cached;
  const provider = new CachingDataProvider(new BlockscoutDataProvider({ chainId }), {
    ttlMs: 60_000,
  });
  providers.set(chainId, provider);
  return provider;
}

/** Whether a recipient can be judged here at all. `riskProvider` throws on a
 *  chain with no explorer, so callers ask this first rather than catching. */
export function canJudgeRecipients(chainId: number): boolean {
  return deploymentFor(chainId)?.explorerApi !== undefined;
}

/** Drop the caches when the connected wallet changes — a different sender has a
 *  different counterparty set, and serving one wallet's from another's would be
 *  the exact mistake the lookalike rule exists to prevent. */
export function clearRiskCache(): void {
  for (const provider of providers.values()) provider.clear();
}
