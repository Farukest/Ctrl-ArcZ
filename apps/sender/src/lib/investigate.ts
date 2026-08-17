import type { Address } from 'viem';
import type { RiskLevel } from '@ctrl-arcz/sdk';
import type { Session } from '@ctrl-arcz/demo-kit';

/**
 * Ask the server for a reasoned second opinion on a recipient.
 *
 * The rule engine has already run in the browser and its verdict stands on its
 * own. This adds context the rules cannot produce — whether the address is a
 * contract, whether it nearly collides with several people you have paid — and
 * it is allowed to make the verdict stricter, never looser. The server clamps
 * that before replying, so nothing here can weaken a block.
 *
 * No wallet signature. This is the firewall's second half, consulted for every
 * address the user types, and a prompt per check is both meaningless and
 * corrosive: nothing is spent, the data read is public, and a user asked to sign
 * on every page load stops reading prompts entirely. Abuse of the operator's
 * model budget is bounded on the server, where it can actually be counted.
 *
 * Every failure path returns null and the UI shows exactly what it shows today.
 */

export interface Advisory {
  level: RiskLevel;
  headline: string;
  points: string[];
}

/**
 * What came back, as three cases rather than one null.
 *
 * "It looked and found nothing" and "it could not be asked" were the same value,
 * so the screen could not tell them apart and rendered neither: after five
 * seconds of "Checking what the rules cannot see", the pending block simply
 * disappeared. A check that ends by vanishing is a check the user has no reason
 * to believe ran, and the one that could not run is the one they most need to
 * know about.
 */
export type Investigation =
  | { status: 'clear' }
  | { status: 'advisory'; advisory: Advisory }
  | { status: 'unavailable' };

export async function investigate(session: Session, target: Address): Promise<Investigation> {
  try {
    const res = await fetch('/api/investigate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The chain decides whose history is read. Without it the server judges the
      // recipient by their Arc activity, which on any other network is a confident
      // answer to a different question.
      body: JSON.stringify({ sender: session.address, target, chainId: session.chainId }),
    });
    if (!res.ok) return { status: 'unavailable' };
    const body = (await res.json()) as { advisory?: Advisory | null };
    return body.advisory ? { status: 'advisory', advisory: body.advisory } : { status: 'clear' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** The advisory to judge with, or null when there is nothing to judge. */
export function advisoryOf(i: Investigation | null): Advisory | null {
  return i && i.status === 'advisory' ? i.advisory : null;
}

const SEVERITY: Record<RiskLevel, number> = { safe: 0, warning: 1, block: 2 };

/** The stricter of the two. Mirrors the server's clamp so the UI cannot show a
 *  weaker verdict than the one the server settled on. */
export function effectiveLevel(rule: RiskLevel, advisory: Advisory | null): RiskLevel {
  if (!advisory) return rule;
  return SEVERITY[advisory.level] > SEVERITY[rule] ? advisory.level : rule;
}
