import { useEffect, useState } from 'react';
import { DEFAULT_TOKEN, type TokenInfo } from '@ctrl-arcz/sdk';

/**
 * The token one screen is working in.
 *
 * Screen-local on purpose. Choosing EURC to pay a merchant says nothing about
 * what the next screen should be denominated in, and a shared selection means a
 * choice made in one place quietly changes the numbers in another, including
 * ones already on screen. Two screens open on two tokens is a normal thing to
 * want; one global token is not.
 *
 * It resets when the wallet changes. A balance belongs to an address, and the
 * new wallet may hold none of what the old one was spending, so carrying the
 * selection across would leave the screen denominated in something the account
 * has never held, showing a zero that reads as a failure rather than a default.
 * USDC is the reset because gas on Arc is USDC: it is the one token a usable
 * wallet here necessarily has.
 */
export function useToken(address: string | undefined): {
  token: TokenInfo;
  setToken: (t: TokenInfo) => void;
} {
  const [token, setToken] = useState<TokenInfo>(DEFAULT_TOKEN);

  useEffect(() => {
    setToken(DEFAULT_TOKEN);
  }, [address]);

  return { token, setToken };
}
