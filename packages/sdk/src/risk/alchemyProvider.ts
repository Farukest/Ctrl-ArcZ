import type { Address } from 'viem';
import type { AddressActivity, CounterpartyScan, IDataProvider } from './types.js';

/**
 * Risk data from Alchemy's Transfers API (`alchemy_getAssetTransfers`).
 *
 * The second history source, for chains where Blockscout cannot be read. Arc
 * mainnet is the reason it exists: its explorer answers every API path with a 403
 * challenge, and no public RPC serves a full-history `eth_getLogs` (Circle's caps a
 * query at 100k blocks, dRPC's free tier at 10k, Blockdaemon's is pruned). Alchemy
 * indexes Arc mainnet from genesis and answers a per-address history in about a
 * second, which is what the firewall needs.
 *
 * The same contract as `BlockscoutDataProvider`, rule for rule: the counterparty
 * scan and the bait count REJECT on a failed fetch so the firewall fails closed,
 * a scan that hits the page cap is marked incomplete, and the activity summary
 * degrades to "unknown" rather than throwing.
 *
 * `rpcUrl` is any endpoint that speaks Alchemy's JSON-RPC: Alchemy itself
 * (`https://arc-mainnet.g.alchemy.com/v2/<key>`) on a server, or a proxy that adds
 * the key on the way through when this runs in a browser. The key never needs to
 * be in the page.
 */

/** Categories that move value: a plain send, a contract's internal send, a token. */
const CATEGORIES = ['external', 'internal', 'erc20'] as const;

/** Alchemy's own page cap, the largest `maxCount` it accepts. */
const PAGE_SIZE = 1000;

/** Cap the walk so a hot wallet cannot make a send wait forever. 10k transfers. */
const MAX_PAGES = 10;

export interface AssetTransfer {
  hash: `0x${string}`;
  from: string | null;
  to: string | null;
  category: string;
  asset: string | null;
  blockNum: string;
  rawContract: { value: string | null; address: string | null; decimal: string | null };
  metadata?: { blockTimestamp?: string } | null;
}

export interface AssetTransferQuery {
  fromAddress?: Address;
  toAddress?: Address;
  excludeZeroValue?: boolean;
  order?: 'asc' | 'desc';
  withMetadata?: boolean;
  /** Stop after this many pages; the result then says it is incomplete. */
  maxPages?: number;
  /** Per page. Defaults to Alchemy's maximum. */
  pageSize?: number;
}

export interface AlchemyTransport {
  rpcUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

async function rpc<T>(t: AlchemyTransport, method: string, params: unknown[]): Promise<T> {
  // Same browser caveat as the Blockscout provider: never call a stored bare
  // `fetch` as a method of something else.
  const doFetch =
    t.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let last = '';
  // 429 and 5xx are retried with backoff, for the same reason as there: a
  // transient refusal would otherwise veto a legitimate send.
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), t.timeoutMs ?? 15_000);
    try {
      const res = await doFetch(t.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as {
          result?: T;
          error?: { code?: number; message?: string };
        };
        if (body.error) {
          // A rate limit can also arrive as a JSON-RPC error inside a 200.
          if (body.error.code === 429) {
            last = 'rate limited';
          } else {
            throw new Error(`${method}: ${body.error.message ?? 'error'}`);
          }
        } else {
          return body.result as T;
        }
      } else {
        last = String(res.status);
        if (res.status !== 429 && res.status < 500)
          throw new Error(`${method}: HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  throw new Error(`${method}: ${last || 'unreachable'}`);
}

/**
 * Every transfer matching a query, walking `pageKey` up to the cap. Rejects if any
 * page fails, so a caller never mistakes a truncated list for a whole one.
 */
export async function getAssetTransfers(
  t: AlchemyTransport,
  q: AssetTransferQuery,
): Promise<{ transfers: AssetTransfer[]; complete: boolean }> {
  const transfers: AssetTransfer[] = [];
  let pageKey: string | undefined;
  const maxPages = q.maxPages ?? MAX_PAGES;
  for (let page = 0; page < maxPages; page++) {
    const res = await rpc<{ transfers?: AssetTransfer[]; pageKey?: string }>(
      t,
      'alchemy_getAssetTransfers',
      [
        {
          fromBlock: '0x0',
          toBlock: 'latest',
          category: CATEGORIES,
          ...(q.fromAddress ? { fromAddress: q.fromAddress } : {}),
          ...(q.toAddress ? { toAddress: q.toAddress } : {}),
          excludeZeroValue: q.excludeZeroValue ?? true,
          order: q.order ?? 'desc',
          withMetadata: q.withMetadata ?? false,
          maxCount: `0x${(q.pageSize ?? PAGE_SIZE).toString(16)}`,
          ...(pageKey ? { pageKey } : {}),
        },
      ],
    );
    for (const tr of res.transfers ?? []) transfers.push(tr);
    pageKey = res.pageKey;
    if (!pageKey) return { transfers, complete: true };
  }
  return { transfers, complete: false };
}

/** A transfer's raw value, or null when Alchemy gave none that parses. */
export function rawValue(t: AssetTransfer): bigint | null {
  const v = t.rawContract?.value;
  if (v === null || v === undefined || v === '') return null;
  try {
    return BigInt(v === '0x' ? '0x0' : v);
  } catch {
    return null;
  }
}

export type AlchemyProviderOptions = AlchemyTransport;

export class AlchemyDataProvider implements IDataProvider {
  private readonly t: AlchemyTransport;

  constructor(options: AlchemyProviderOptions) {
    this.t = {
      rpcUrl: options.rpcUrl,
      timeoutMs: options.timeoutMs ?? 15_000,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    };
  }

  /** Every address this sender moved a non-zero value to. Rejects on failure. */
  async getOutgoingCounterparties(sender: Address): Promise<CounterpartyScan> {
    const { transfers, complete } = await getAssetTransfers(this.t, {
      fromAddress: sender,
      excludeZeroValue: true,
    });
    const counterparties = new Set<string>();
    for (const tr of transfers) {
      const value = rawValue(tr);
      // Same rule as Blockscout's: a 0-value transfer is not a relationship.
      if (tr.to && value !== null && value > 0n) counterparties.add(tr.to.toLowerCase());
    }
    counterparties.delete(sender.toLowerCase());
    return { counterparties: [...counterparties] as Address[], complete };
  }

  /**
   * The nonce is the count of transactions sent, which is exactly what this field
   * means and needs no indexer. The age is the oldest transfer either way.
   */
  async getAddressActivity(address: Address): Promise<AddressActivity> {
    const [nonce, firstOut, firstIn] = await Promise.all([
      rpc<string>(this.t, 'eth_getTransactionCount', [address, 'latest']).catch(() => '0x0'),
      this.oldest({ fromAddress: address }),
      this.oldest({ toAddress: address }),
    ]);
    const times = [firstOut, firstIn].filter((d): d is Date => d !== null);
    return {
      transactionCount: Number(BigInt(nonce)),
      firstSeenAt: times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null,
    };
  }

  private async oldest(q: { fromAddress?: Address; toAddress?: Address }): Promise<Date | null> {
    try {
      const { transfers } = await getAssetTransfers(this.t, {
        ...q,
        excludeZeroValue: false,
        order: 'asc',
        withMetadata: true,
        maxPages: 1,
        pageSize: 1,
      });
      const ts = transfers[0]?.metadata?.blockTimestamp;
      const d = ts ? new Date(ts) : null;
      return d && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }

  /** 0-value transfers `from` -> `to`. Rejects on failure: "no bait" must be earned. */
  async countZeroValueTransfers(from: Address, to: Address): Promise<number> {
    const { transfers } = await getAssetTransfers(this.t, {
      fromAddress: from,
      toAddress: to,
      excludeZeroValue: false,
    });
    return transfers.filter((tr) => rawValue(tr) === 0n).length;
  }
}
