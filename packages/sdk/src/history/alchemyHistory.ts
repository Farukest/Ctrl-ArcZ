import type { Address } from 'viem';
import {
  getAssetTransfers,
  rawValue,
  type AlchemyTransport,
  type AssetTransfer,
} from '../risk/alchemyProvider.js';
import type { CleanHistory, EntryKind, FilteredEntry, HistoryEntry } from './history.js';

/**
 * `getCleanHistory`, read from Alchemy's Transfers API instead of Blockscout.
 *
 * Same two rules, same output: 0-value rows and unknown tokens go to `filtered`,
 * never away. The one thing Blockscout did not have to handle is the chain's own
 * coin. On Arc that coin IS USDC, so a plain send of it is a USDC payment and must
 * show as one: `native` names the token it counts as and the precision it arrives
 * in (Arc's native balance is 18 decimals, the token 6).
 */
export interface AlchemyHistoryOptions extends AlchemyTransport {
  /** Tokens that may appear in the clean view. */
  allowedTokens: Address[];
  /**
   * What a native-coin row is, where the native coin is a token the app knows.
   * Omit on a chain whose coin is not in the allowlist; such rows then land in
   * `filtered` as an unknown token, which is the honest place for them.
   */
  native?: { address: Address; symbol: string; decimals: number; sourceDecimals: number };
  /** Rows per direction. Default 100, the most a screen shows at once. */
  limit?: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export async function getCleanHistoryFromAlchemy(
  address: Address,
  options: AlchemyHistoryOptions,
): Promise<CleanHistory> {
  const limit = options.limit ?? 100;
  const query = {
    excludeZeroValue: false,
    order: 'desc' as const,
    withMetadata: true,
    maxPages: 1,
    pageSize: limit,
  };
  // Both directions, and both must succeed: half a history is a wrong history.
  const [out, inc] = await Promise.all([
    getAssetTransfers(options, { ...query, fromAddress: address }),
    getAssetTransfers(options, { ...query, toAddress: address }),
  ]);

  const allowed = new Set(options.allowedTokens.map((t) => t.toLowerCase()));
  const self = address.toLowerCase();
  const seen = new Set<string>();
  const entries: HistoryEntry[] = [];
  const filtered: FilteredEntry[] = [];

  const rows = [...out.transfers, ...inc.transfers].sort((a, b) =>
    Number(BigInt(b.blockNum) - BigInt(a.blockNum)),
  );
  for (const raw of rows) {
    // A self-transfer comes back from both queries.
    const key = `${raw.hash}:${raw.category}:${raw.from}:${raw.to}:${raw.rawContract?.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = toEntry(raw, self, options);
    if (!entry) continue;
    if (entry.amount === 0n) {
      filtered.push({ ...entry, reason: 'ZERO_VALUE' });
    } else if (!entry.tokenAddress || !allowed.has(entry.tokenAddress.toLowerCase())) {
      filtered.push({ ...entry, reason: 'UNKNOWN_TOKEN' });
    } else {
      entries.push(entry);
    }
  }
  return { entries, filtered };
}

function toEntry(
  raw: AssetTransfer,
  self: string,
  options: AlchemyHistoryOptions,
): HistoryEntry | null {
  const from = raw.from;
  const to = raw.to;
  if (!from || !to || !raw.hash) return null;
  const direction = to.toLowerCase() === self ? 'in' : 'out';
  const counterparty = (direction === 'in' ? from : to) as Address;
  const kind: EntryKind =
    from.toLowerCase() === ZERO ? 'mint' : to.toLowerCase() === ZERO ? 'burn' : 'transfer';
  const value = rawValue(raw) ?? 0n;
  const isNative = raw.category === 'external' || raw.category === 'internal';

  let tokenAddress: Address | null;
  let amount: bigint;
  let decimals: number;
  let symbol: string;
  if (isNative && options.native) {
    const n = options.native;
    tokenAddress = n.address;
    // Down to the token's precision. Dust below one token unit is not a payment
    // anybody made on purpose and would read as a zero anyway.
    amount = value / 10n ** BigInt(Math.max(0, n.sourceDecimals - n.decimals));
    decimals = n.decimals;
    symbol = n.symbol;
  } else {
    tokenAddress = (isNative ? null : (raw.rawContract?.address ?? null)) as Address | null;
    amount = value;
    const d = raw.rawContract?.decimal ? Number(BigInt(raw.rawContract.decimal)) : NaN;
    decimals = Number.isFinite(d) ? d : 6;
    symbol = raw.asset ?? '???';
  }

  const ts = raw.metadata?.blockTimestamp;
  return {
    txHash: raw.hash,
    direction,
    counterparty,
    kind,
    method: null,
    amount,
    decimals,
    tokenAddress,
    tokenSymbol: symbol,
    timestamp: ts ? new Date(ts) : new Date(0),
  };
}
