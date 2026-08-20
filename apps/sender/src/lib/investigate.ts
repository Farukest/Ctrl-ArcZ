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
  /**
   * `why` separates three things the screen used to show as one.
   *
   * `unreachable` is the network failing. `off` is a server with no model key
   * configured, which is every local checkout, since the key has exactly one copy
   * and it is not on anyone's laptop. `budget` is the operator's daily model spend
   * being gone. All three leave the rules standing on their own, and none of them
   * is "the check ran and cleared this address" -- which is what the screen said
   * for two of them until the server started telling them apart.
   */
  | { status: 'unavailable'; why: 'unreachable' | 'off' | 'budget' };

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
    if (!res.ok) return { status: 'unavailable', why: 'unreachable' };
    const body = (await res.json()) as {
      advisory?: Advisory | null;
      deep?: 'ran' | 'off' | 'budget';
    };
    if (body.advisory) return { status: 'advisory', advisory: body.advisory };
    // An older server does not send `deep`. Reading its silence as "it ran" keeps
    // the previous behaviour rather than accusing it of a gap it may not have.
    if (body.deep === 'off' || body.deep === 'budget') {
      return { status: 'unavailable', why: body.deep };
    }
    return { status: 'clear' };
  } catch {
    return { status: 'unavailable', why: 'unreachable' };
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
