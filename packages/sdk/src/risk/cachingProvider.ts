import type { Address } from 'viem';
import type { AddressActivity, CounterpartyScan, IDataProvider } from './types.js';

/**
 * A short-lived cache in front of a risk data provider.
 *
 * The expensive call by far is `getOutgoingCounterparties`: the indexer paginates
 * a sender's whole outgoing history, and a wallet with real usage walks ten pages
 * at roughly five seconds each. The firewall runs on every debounced keystroke, so
 * without a cache a busy sender waits half a minute for a verdict and then waits
 * again for the next address they try — which reads as a broken app, not a
 * careful one.
 *
 * A sender's counterparty set is exactly the kind of thing that is safe to cache
 * for a short window: it only ever grows, and it grows when *they* pay someone
 * new, which is not something that happens between two keystrokes.
 *
 * Two rules keep this from weakening the firewall:
 *
 *   - **Failures are never cached.** `getOutgoingCounterparties` must reject when
 *     history cannot be fetched, because that rejection is what makes the firewall
 *     fail closed. Caching a failure would turn one indexer blip into a window
 *     where lookalike detection is quietly off.
 *   - **Incomplete scans are never cached.** A scan that hit its page cap may be
 *     missing a counterparty, and the report is marked incomplete because of it.
 *     Re-fetching gives it another chance to complete rather than freezing the gap.
 */
export interface CachingProviderOptions {
  /** How long a successful, complete scan stays fresh. Default 60s. */
  ttlMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

export class CachingDataProvider implements IDataProvider {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly counterparties = new Map<string, { at: number; value: CounterpartyScan }>();
  /** De-duplicates concurrent calls for the same sender into one request. */
  private readonly inFlight = new Map<string, Promise<CounterpartyScan>>();

  constructor(
    private readonly inner: IDataProvider,
    options: CachingProviderOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async getOutgoingCounterparties(sender: Address): Promise<CounterpartyScan> {
    const key = sender.toLowerCase();

    const hit = this.counterparties.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.inner
      .getOutgoingCounterparties(sender)
      .then((scan) => {
        // Only a scan that actually finished is worth remembering.
        if (scan.complete) this.counterparties.set(key, { at: this.now(), value: scan });
        return scan;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }

  /** Not cached: the target changes with every address the user types, so a cache
   *  here would only ever grow and never be read. */
  getAddressActivity(address: Address): Promise<AddressActivity> {
    return this.inner.getAddressActivity(address);
  }

  /** Not cached, for the same reason, and because a bait transfer landing between
   *  two checks is exactly the thing the firewall must not miss. */
  countZeroValueTransfers(from: Address, to: Address): Promise<number> {
    return this.inner.countZeroValueTransfers(from, to);
  }

  /** Drop everything. Call after the connected wallet changes. */
  clear(): void {
    this.counterparties.clear();
  }
}
