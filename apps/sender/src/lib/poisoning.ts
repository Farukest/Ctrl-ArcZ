import type { Address } from 'viem';
import { craftLookalike } from '@ctrl-arcz/sdk';
import { verifiedRecipients } from './verifiedRecipients.js';

/** Configured stand-in for a wallet that has completed no protected transfer yet. */
const FALLBACK = import.meta.env.VITE_DEMO_RECEIVER as Address | undefined;

/**
 * Craft a real lookalike of someone this wallet has actually paid.
 *
 * The attack this product exists to stop only works against a counterparty the
 * victim already trusts, so a canned address proves nothing: the firewall would
 * just call it a new address and let it through. It has to imitate someone in the
 * sender's own verified set, and it has to be the same set the firewall checks
 * against, or the demo shows a block the real thing would not produce.
 *
 * That set comes from the server's index rather than a block scan. A bounded
 * lookback silently excluded anyone paid more than a few hours ago, which made
 * this demo fall back to a configured address the firewall did not recognise —
 * so it crafted a convincing lookalike of nobody, and nothing was blocked.
 *
 * Returns null when the wallet has completed no protected transfer and no
 * fallback is configured; there is no honest scenario to show in that case.
 */
export async function craftLookalikeOfKnownRecipient(
  sender: Address,
): Promise<{ real: Address; fake: Address } | null> {
  const { recipients } = await verifiedRecipients(sender);
  const real = recipients[recipients.length - 1] ?? FALLBACK ?? null;
  if (!real) return null;
  return { real, fake: craftLookalike(real) };
}
