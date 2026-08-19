import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, type Address } from 'viem';
import { deploymentFor, tokensFor, type TokenInfo } from '@ctrl-arcz/sdk';
import type { Session } from '@ctrl-arcz/demo-kit';
import { readClientFor } from './chainRead.js';

/**
 * What this wallet holds of each token, in that token's base units, keyed by symbol.
 *
 * All of them, not just the selected one: the picker's reason for existing is the
 * question "which of these have I got", and a list showing a balance for the row
 * already chosen and nothing for the others answers it for the one case where the
 * user did not need to ask.
 *
 * USDC comes from the balance the session already polls rather than being read
 * again. It is the same number from the same contract, and two reads of one
 * balance is two answers that can disagree on screen.
 *
 * A missing entry means not known, and it stays missing rather than becoming `0n`
 * while a read is in flight or after one fails. A zero is a claim about someone's
 * money; "not read" is not one, and the picker renders the two differently.
 */
export function useTokenBalances(
  session: Session,
  usdcBalance: bigint | null,
  tokens: readonly TokenInfo[] = tokensFor(session.chainId),
): {
  balances: Partial<Record<string, bigint>>;
  /**
   * Whether a read has been attempted since the wallet or chain last changed.
   *
   * A missing balance means two different things and the screen renders them
   * differently: before the first read it is on its way, after one it is not
   * coming. Without this the amount field shimmered forever on any chain whose
   * token could not be reached -- a promise the app could never keep.
   */
  attempted: boolean;
  refresh: () => Promise<void>;
} {
  const [read, setRead] = useState<Partial<Record<string, bigint>>>({});
  const [attempted, setAttempted] = useState(false);
  // Which row the session's own poll already answers, on *this* chain. Naming
  // Arc's USDC here got both halves wrong at once off Arc: the chain's real USDC
  // failed the test and went off to be read again, and the balance the session had
  // already fetched matched no row and was dropped.
  const sessionUsdc = deploymentFor(session.chainId)?.usdc.toLowerCase();
  const isSessionUsdc = (t: TokenInfo) =>
    sessionUsdc !== undefined && t.address.toLowerCase() === sessionUsdc;
  const others = tokens.filter((t) => !isSessionUsdc(t));
  const key = others.map((t) => t.address).join(',');

  const refresh = useCallback(async () => {
    // The chain the wallet is on, not Arc. A balance read pointed at the wrong
    // chain does not fail loudly: the address is simply not a contract there.
    const client = readClientFor(session);
    const results = await Promise.all(
      key
        .split(',')
        .filter(Boolean)
        .map(async (address) => {
          const token = tokens.find((t) => t.address === address);
          if (!token) return null;
          try {
            const raw = await client.readContract({
              address: token.address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [session.address as Address],
            });
            return [token.symbol, raw] as const;
          } catch {
            return null;
          }
        }),
    );
    setRead((prev) => {
      const next = { ...prev };
      for (const r of results) if (r) next[r[0]] = r[1];
      return next;
    });
    setAttempted(true);
  }, [key, tokens, session]);

  // A different wallet has different balances, so the previous account's numbers
  // are wrong the instant the address changes, not once the new read lands.
  useEffect(() => {
    setRead({});
    setAttempted(false);
  }, [session.address, session.chainId]);

  useEffect(() => {
    // Nothing to read is a finished state, not a pending one. Off Arc the registry
    // holds USDC alone, the session already polls it, and leaving `attempted` false
    // here would shimmer a balance that was never going to be fetched -- the same
    // forever-promise this flag exists to prevent.
    if (!key) {
      setAttempted(true);
      return;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [key, refresh]);

  const balances: Partial<Record<string, bigint>> = { ...read };
  for (const t of tokens) {
    if (isSessionUsdc(t) && usdcBalance !== null) balances[t.symbol] = usdcBalance;
  }
  return { balances, attempted, refresh };
}
