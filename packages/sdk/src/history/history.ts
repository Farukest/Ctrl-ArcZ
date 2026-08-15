import type { Address } from 'viem';
import { EXPLORER_API_URL, ADDRESSES } from '../chains/arcTestnet.js';

/**
 * What produced a row, when the counterparty alone cannot say.
 *
 * A mint has no sender and a burn has no recipient, so both arrive from the
 * indexer with `0x0000…0000` on one side. Rendering that as an address tells the
 * holder they were paid by nobody, when on Arc it is almost always their own money
 * arriving over a bridge: CCTP settles as `receiveMessage` and Circle Gateway as
 * `gatewayMint`, and both are mints to the recipient.
 */
export type EntryKind = 'transfer' | 'mint' | 'burn';

export interface HistoryEntry {
  txHash: `0x${string}`;
  direction: 'in' | 'out';
  /** `0x0000…0000` when `kind` is not `transfer`; read `kind` before showing it. */
  counterparty: Address;
  kind: EntryKind;
  /**
   * The contract call the indexer attributed the row to, verbatim and untrusted:
   * `receiveMessage`, `gatewayMint`, `transfer`. Null when it named none. Useful
   * for telling one kind of mint from another; never for deciding whether to trust
   * a row.
   */
  method: string | null;
  /** Base units, in the token's own decimals. */
  amount: bigint;
  decimals: number;
  /** Null when the explorer named no token for the row — such a row is never clean. */
  tokenAddress: Address | null;
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
  method?: string | null;
  from?: { hash?: string } | null;
  to?: { hash?: string } | null;
  total?: { value?: string | null; decimals?: string | null } | null;
  /**
   * Blockscout serves the token's address as `address_hash`; older builds of it
   * used `address`. Both are read, because reading only one of them is how this
   * silently returned an empty history: every row was dropped for having no token
   * address, so the clean view AND the spam list were empty for every wallet, and
   * an empty list is indistinguishable from "you have no history".
   */
  token?: { address_hash?: string; address?: string; symbol?: string; decimals?: string } | null;
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
  const ZERO = '0x0000000000000000000000000000000000000000';

  const entries: HistoryEntry[] = [];
  const filtered: FilteredEntry[] = [];

  for (const raw of body.items ?? []) {
    const from = raw.from?.hash;
    const to = raw.to?.hash;
    const tokenAddress = (raw.token?.address_hash ?? raw.token?.address ?? null) as Address | null;
    // A row with no counterparty or no hash cannot be rendered at all. A row with
    // no *token* can: it just cannot be allowlisted, so it goes to `filtered`
    // rather than being dropped. Dropping was the shape of the last bug here.
    if (!from || !to || !raw.transaction_hash) continue;

    const direction = to.toLowerCase() === self ? 'in' : 'out';
    const counterparty = (direction === 'in' ? from : to) as Address;
    const amount = safeBigInt(raw.total?.value);
    const rawDecimals = Number(raw.token?.decimals ?? raw.total?.decimals);
    const decimals = Number.isFinite(rawDecimals) ? rawDecimals : 6;

    // Derived from the addresses, not from the indexer's own `type` field: a mint
    // is "came from nowhere" whatever the indexer chose to call it, and one less
    // string to trust is one less string to be wrong about.
    const kind: EntryKind =
      from.toLowerCase() === ZERO ? 'mint' : to.toLowerCase() === ZERO ? 'burn' : 'transfer';

    const entry: HistoryEntry = {
      txHash: raw.transaction_hash as `0x${string}`,
      direction,
      counterparty,
      kind,
      method: raw.method ?? null,
      amount,
      decimals,
      tokenAddress,
      tokenSymbol: raw.token?.symbol ?? '???',
      timestamp: raw.timestamp ? new Date(raw.timestamp) : new Date(0),
    };

    if (amount === 0n) {
      filtered.push({ ...entry, reason: 'ZERO_VALUE' });
    } else if (!tokenAddress || !allowed.has(tokenAddress.toLowerCase())) {
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
