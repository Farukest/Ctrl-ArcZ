import type { Address } from 'viem';
import { CTRL_ARCZ_ADDRESS, ctrlArcZAbi, craftLookalike, getLogsChunked } from '@ctrl-arcz/sdk';
import { getPublicClient } from '@ctrl-arcz/demo-kit';

/** How far back to look for someone this wallet has already paid. */
const LOOKBACK = 200_000n;

/** Configured stand-in for a wallet with no history yet (demo builds only). */
const FALLBACK = import.meta.env.VITE_DEMO_RECEIVER as Address | undefined;

/**
 * Craft a real lookalike of someone this wallet has actually paid.
 *
 * The attack this product exists to stop only works against a counterparty the
 * victim already trusts, so a canned address proves nothing: the firewall would
 * just call it a new address. Crafting the lookalike from the connected wallet's
 * own verified recipients is what makes the demo the real thing, and it is why
 * this reads history instead of taking an address from configuration.
 *
 * Returns null when the wallet has paid nobody yet and no fallback is configured;
 * there is no honest scenario to show in that case.
 */
export async function craftLookalikeOfKnownRecipient(
  sender: Address,
): Promise<{ real: Address; fake: Address } | null> {
  const real = (await lastVerifiedRecipient(sender)) ?? FALLBACK ?? null;
  if (!real) return null;
  return { real, fake: craftLookalike(real) };
}

async function lastVerifiedRecipient(sender: Address): Promise<Address | null> {
  try {
    const client = getPublicClient();
    const latest = await client.getBlockNumber();
    const logs = await getLogsChunked<{ recipient?: Address }>(client, {
      address: CTRL_ARCZ_ADDRESS,
      abi: ctrlArcZAbi,
      eventName: 'RecipientVerified',
      args: { sender },
      fromBlock: latest > LOOKBACK ? latest - LOOKBACK : 0n,
    });
    for (let i = logs.length - 1; i >= 0; i--) {
      const r = logs[i]?.args.recipient;
      if (r) return r;
    }
    return null;
  } catch {
    return null; // no history reachable: fall back rather than fail the page
  }
}
