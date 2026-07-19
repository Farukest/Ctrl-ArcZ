import type { Address } from 'viem';
import { EXPLORER_API_URL } from '../chains/arcTestnet.js';
import type { AddressActivity, CounterpartyScan, IDataProvider } from './types.js';

/**
 * Risk data from ArcScan, which runs Blockscout.
 *
 * The endpoint shapes are not documented in the Arc docs; they were verified
 * against the live API:
 *   GET /addresses/{a}/transactions?filter=from
 *   GET /addresses/{a}/token-transfers[?filter=from]
 *   GET /addresses/{a}/counters
 */

interface BlockscoutAddressRef {
  hash: Address;
}

interface BlockscoutTransaction {
  from: BlockscoutAddressRef | null;
  to: BlockscoutAddressRef | null;
  value: string;
  timestamp: string | null;
}

interface BlockscoutTokenTransfer {
  from: BlockscoutAddressRef | null;
  to: BlockscoutAddressRef | null;
  total?: { value?: string | null } | null;
  timestamp: string | null;
}

interface Paged<T> {
  items?: T[] | null;
  /** Blockscout v2 cursor: query params to append for the next page, or null at the end. */
  next_page_params?: Record<string, string | number> | null;
}

/** Cap the counterparty scan so a hot wallet cannot make it run forever. If the
 *  history is longer than this, the scan is marked incomplete (never authoritative). */
const MAX_COUNTERPARTY_PAGES = 10;

export interface BlockscoutProviderOptions {
  /** Defaults to Arc Testnet's ArcScan. */
  apiUrl?: string;
  /** Abort a slow explorer rather than stalling a send. Default 8000 ms. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class BlockscoutDataProvider implements IDataProvider {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: BlockscoutProviderOptions = {}) {
    this.apiUrl = options.apiUrl ?? EXPLORER_API_URL;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.apiUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Explorer ${response.status} for ${path}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Walk a Blockscout list endpoint across pages, following `next_page_params` up
   * to `maxPages`. Returns whether the whole history was consumed (`complete`) — if
   * a cursor remains at the cap, the caller must treat the result as partial. A
   * fetch failure on ANY page rejects, so callers fail closed rather than seeing a
   * silently truncated list.
   */
  private async getAllPages<T>(basePath: string, maxPages: number): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    let cursor: Record<string, string | number> | null = null;
    for (let page = 0; page < maxPages; page++) {
      const sep = basePath.includes('?') ? '&' : '?';
      const query = cursor
        ? sep + new URLSearchParams(Object.entries(cursor).map(([k, v]) => [k, String(v)])).toString()
        : '';
      const res: Paged<T> = await this.get<Paged<T>>(`${basePath}${query}`);
      for (const it of res.items ?? []) items.push(it);
      cursor = res.next_page_params ?? null;
      if (!cursor) return { items, complete: true };
    }
    // Cursor still set after maxPages: history longer than we scanned.
    return { items, complete: false };
  }

  /** Every address this sender has moved value to, from both native and ERC-20 paths.
   *  Rejects if either list cannot be fetched (fail closed); marks the scan partial
   *  if the history is longer than the page cap. */
  async getOutgoingCounterparties(sender: Address): Promise<CounterpartyScan> {
    // NOT swallowed: a failure here must propagate so `check` marks the report
    // incomplete and the firewall fails closed instead of "no counterparties".
    const [transfers, transactions] = await Promise.all([
      this.getAllPages<BlockscoutTokenTransfer>(
        `/addresses/${sender}/token-transfers?filter=from`,
        MAX_COUNTERPARTY_PAGES,
      ),
      this.getAllPages<BlockscoutTransaction>(
        `/addresses/${sender}/transactions?filter=from`,
        MAX_COUNTERPARTY_PAGES,
      ),
    ]);

    const counterparties = new Set<string>();

    for (const t of transfers.items) {
      // A 0-value transfer the sender made is not a counterparty relationship.
      if (t.to?.hash && !isZero(t.total?.value)) counterparties.add(t.to.hash.toLowerCase());
    }
    for (const t of transactions.items) {
      if (t.to?.hash && !isZero(t.value)) counterparties.add(t.to.hash.toLowerCase());
    }

    counterparties.delete(sender.toLowerCase());
    return {
      counterparties: [...counterparties] as Address[],
      complete: transfers.complete && transactions.complete,
    };
  }

  /**
   * @dev `/counters` is computed asynchronously and returns "0" on a cold cache —
   *      a freshly queried, long-lived address can momentarily look brand new.
   *      Trusting it would make the firewall flag legitimate addresses, so the
   *      transaction list is authoritative here and counters only fill in a count
   *      the list cannot see past its first page.
   */
  async getAddressActivity(address: Address): Promise<AddressActivity> {
    const [transactions, transfers] = await Promise.all([
      this.get<Paged<BlockscoutTransaction>>(`/addresses/${address}/transactions`).catch(() => ({
        items: [],
      })),
      this.get<Paged<BlockscoutTokenTransfer>>(`/addresses/${address}/token-transfers`).catch(
        () => ({ items: [] }),
      ),
    ]);

    const timestamps = [
      ...(transactions.items ?? []).map((t) => t.timestamp),
      ...(transfers.items ?? []).map((t) => t.timestamp),
    ]
      .filter((t): t is string => Boolean(t))
      .map((t) => new Date(t))
      .filter((d) => !Number.isNaN(d.getTime()));

    // The lists come back newest-first, so the oldest entry on the page is the
    // best lower bound we have on the address's age.
    const firstSeenAt =
      timestamps.length > 0 ? new Date(Math.min(...timestamps.map((d) => d.getTime()))) : null;

    const counted = (transactions.items ?? []).length;
    let transactionCount = counted;

    // Only consult counters when the list is empty; that is the one case where the
    // list itself cannot distinguish "unused" from "not indexed yet".
    if (counted === 0) {
      const counters = await this.get<{ transactions_count?: string }>(
        `/addresses/${address}/counters`,
      ).catch(() => ({ transactions_count: '0' }));
      transactionCount = Number(counters.transactions_count ?? '0') || 0;
    }

    return { transactionCount, firstSeenAt };
  }

  /** 0-value transfers `from` → `to`: the bait that plants an address in a history. */
  async countZeroValueTransfers(from: Address, to: Address): Promise<number> {
    // The primary call is intentionally NOT swallowed: if the explorer is
    // unreachable we want `check` to mark the report incomplete rather than report
    // "no bait". A fresh `from` (the usual lookalike case) returns 200 with an
    // empty list, so this does not spuriously fail.
    const [transfers, transactions] = await Promise.all([
      this.get<Paged<BlockscoutTokenTransfer>>(`/addresses/${from}/token-transfers?filter=from`),
      this.get<Paged<BlockscoutTransaction>>(`/addresses/${from}/transactions?filter=from`).catch(
        () => ({ items: [] }),
      ),
    ]);

    const target = to.toLowerCase();

    const zeroTransfers = (transfers.items ?? []).filter(
      (t) => t.to?.hash?.toLowerCase() === target && isZero(t.total?.value),
    ).length;

    const zeroTransactions = (transactions.items ?? []).filter(
      (t) => t.to?.hash?.toLowerCase() === target && isZero(t.value),
    ).length;

    return zeroTransfers + zeroTransactions;
  }
}

function isZero(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false;
  try {
    return BigInt(value) === 0n;
  } catch {
    return false;
  }
}
