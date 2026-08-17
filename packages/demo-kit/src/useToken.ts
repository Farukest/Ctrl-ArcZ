import { useEffect, useState } from 'react';
import { DEFAULT_TOKEN, defaultTokenFor, tokensFor, type TokenInfo } from '@ctrl-arcz/sdk';

/**
 * The token one screen is working in.
 *
 * Screen-local on purpose. Choosing EURC to pay a merchant says nothing about
 * what the next screen should be denominated in, and a shared selection means a
 * choice made in one place quietly changes the numbers in another, including
 * ones already on screen. Two screens open on two tokens is a normal thing to
 * want; one global token is not.
 *
 * It resets when the wallet changes, and when the chain changes.
 *
 * The wallet, because a balance belongs to an address: the new one may hold none
 * of what the old one was spending, and carrying the selection over leaves the
 * screen denominated in something the account has never held, showing a zero that
 * reads as a failure rather than as a default.
 *
 * The chain, because a symbol is not a token. "EURC" is a different contract on
 * every network, and holding a selection across a switch would keep a name on
 * screen while the address under it changed, which is the one thing an amount
 * field must never do.
 */
export function useToken(
  address: string | undefined,
  chainId: number | undefined,
): { token: TokenInfo; setToken: (t: TokenInfo) => void } {
  const [token, setToken] = useState<TokenInfo>(() => defaultTokenFor(chainId) ?? DEFAULT_TOKEN);

  useEffect(() => {
    setToken((current) => {
      // Keep the choice when it still means the same contract on the new chain,
      // so a reconnect that reports the same network does not silently undo it.
      const stillHere = tokensFor(chainId).find(
        (t) => t.symbol === current.symbol && t.address === current.address && !t.restricted,
      );
      return stillHere ?? defaultTokenFor(chainId) ?? DEFAULT_TOKEN;
    });
  }, [address, chainId]);

  return { token, setToken };
}
