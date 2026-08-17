import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, type Address } from 'viem';
import { ADDRESSES, tokensFor, type TokenInfo } from '@ctrl-arcz/sdk';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';

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
  const isUsdc = (t: TokenInfo) =>
    t.address.toLowerCase() === (ADDRESSES.USDC as string).toLowerCase();
  const others = tokens.filter((t) => !isUsdc(t));
  const key = others.map((t) => t.address).join(',');

  const refresh = useCallback(async () => {
    const client = getPublicClient();
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
  }, [key, tokens, session.address]);

  // A different wallet has different balances, so the previous account's numbers
  // are wrong the instant the address changes, not once the new read lands.
  useEffect(() => {
    setRead({});
    setAttempted(false);
  }, [session.address, session.chainId]);

  useEffect(() => {
    if (!key) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [key, refresh]);

  const balances: Partial<Record<string, bigint>> = { ...read };
  for (const t of tokens) {
    if (isUsdc(t) && usdcBalance !== null) balances[t.symbol] = usdcBalance;
  }
  return { balances, attempted, refresh };
}
