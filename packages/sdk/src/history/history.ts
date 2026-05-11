import type { Address } from 'viem';
import { EXPLORER_API_URL, ADDRESSES } from '../chains/arcTestnet.js';

export interface HistoryEntry {
  txHash: `0x${string}`;
  direction: 'in' | 'out';
  counterparty: Address;
  /** Base units, in the token's own decimals. */
  amount: bigint;
  decimals: number;
  tokenAddress: Address;
  tokenSymbol: string;
  timestamp: Date;
}

export interface FilteredEntry extends HistoryEntry {
  reason: 'ZERO_VALUE' | 'UNKNOWN_TOKEN';
}

export interface CleanHistory {
  entries: HistoryEntry[];
  /** What was hidden, and why. Shown behind a "spam" toggle rather than destroyed. */
  filtered: FilteredEntry[];
}

export interface GetCleanHistoryOptions {
  apiUrl?: string;
  fetchFn?: typeof fetch;
  /**
   * Tokens that may appear in the clean view. Defaults to Arc's own assets.
   * A poisoning campaign usually ships its own worthless token to look real, so
   * an allowlist is the only filter that actually holds; a blocklist is always a
   * step behind the next contract address.
   */
  allowedTokens?: Address[];
}

interface RawTransfer {
  transaction_hash?: string;
  timestamp?: string | null;
  from?: { hash?: string } | null;
  to?: { hash?: string } | null;
  total?: { value?: string | null; decimals?: string | null } | null;
  token?: { address?: string; symbol?: string; decimals?: string } | null;
}

/**
 * Layer 3 — the history a wallet should show.
 *
 * Address poisoning only works because the fake address is *sitting in the
 * victim's history*, one tap from being copied. Two rules destroy that surface:
 *
 *  1. Drop 0-value transfers. Sending someone 0 tokens has no legitimate purpose.
 *  2. Show only known tokens. Poisoning campaigns mint a lookalike token so their
 *     row reads like a real USDC line.
 *
 * Nothing is deleted — `filtered` carries the hidden rows so a UI can still offer
 * "show spam", which keeps the SDK honest about what it did.
 */
export async function getCleanHistory(
  address: Address,
  options: GetCleanHistoryOptions = {},
): Promise<CleanHistory> {
  const apiUrl = options.apiUrl ?? EXPLORER_API_URL;
  const fetchFn = options.fetchFn ?? fetch;
  const allowed = new Set(
    (options.allowedTokens ?? [ADDRESSES.USDC, ADDRESSES.EURC]).map((t) => t.toLowerCase()),
  );

  const response = await fetchFn(`${apiUrl}/addresses/${address}/token-transfers`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Explorer ${response.status} while reading history for ${address}`);
  }

  const body = (await response.json()) as { items?: RawTransfer[] | null };
  const self = address.toLowerCase();

  const entries: HistoryEntry[] = [];
  const filtered: FilteredEntry[] = [];

  for (const raw of body.items ?? []) {
    const from = raw.from?.hash;
    const to = raw.to?.hash;
    const tokenAddress = raw.token?.address;
    if (!from || !to || !tokenAddress || !raw.transaction_hash) continue;

    const direction = to.toLowerCase() === self ? 'in' : 'out';
    const counterparty = (direction === 'in' ? from : to) as Address;
    const amount = safeBigInt(raw.total?.value);
    const rawDecimals = Number(raw.token?.decimals ?? raw.total?.decimals);
    const decimals = Number.isFinite(rawDecimals) ? rawDecimals : 6;

    const entry: HistoryEntry = {
      txHash: raw.transaction_hash as `0x${string}`,
      direction,
      counterparty,
      amount,
      decimals,
      tokenAddress: tokenAddress as Address,
      tokenSymbol: raw.token?.symbol ?? '???',
      timestamp: raw.timestamp ? new Date(raw.timestamp) : new Date(0),
    };

    if (amount === 0n) {
      filtered.push({ ...entry, reason: 'ZERO_VALUE' });
    } else if (!allowed.has(tokenAddress.toLowerCase())) {
      filtered.push({ ...entry, reason: 'UNKNOWN_TOKEN' });
    } else {
      entries.push(entry);
    }
  }

  return { entries, filtered };
}

function safeBigInt(value: string | null | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
