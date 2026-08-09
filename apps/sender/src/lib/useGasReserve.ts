import { useEffect, useState } from 'react';
import { readGasReserve, SEND_GAS_LIMIT } from '@ctrl-arcz/sdk';
import { getPublicClient } from '@ctrl-arcz/demo-kit';

/**
 * What this operation will need for its own gas, in the token it is spending.
 *
 * Arc charges gas in USDC out of the same balance as the payment, so every screen
 * that moves money owes two answers rather than one, and both used to be missing:
 * "Max" offered the whole balance, which is the one amount guaranteed to produce a
 * transaction that cannot be mined, and the form said nothing about the difference.
 *
 * Here rather than in each screen because the send and the private payment ask the
 * same question with different limits, and a screen that works this out for itself
 * is the one that will forget the reserve.
 *
 * Read once. The reserve is a ceiling over a floor rather than a live price, and
 * Arc's base fee has a 20 Gwei minimum it sits at, so re-reading it every fifteen
 * seconds would move a figure on screen without ever changing what it means.
 */
export function useGasReserve(gasLimit: bigint = SEND_GAS_LIMIT): bigint | null {
  const [reserve, setReserve] = useState<bigint | null>(null);

  useEffect(() => {
    let live = true;
    void readGasReserve(getPublicClient(), gasLimit).then((r) => {
      if (live) setReserve(r);
    });
    return () => {
      live = false;
    };
  }, [gasLimit]);

  return reserve;
}
