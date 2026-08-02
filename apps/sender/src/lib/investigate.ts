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

export async function investigate(session: Session, target: Address): Promise<Advisory | null> {
  try {
    const res = await fetch('/api/investigate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: session.address, target }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { advisory?: Advisory | null };
    return body.advisory ?? null;
  } catch {
    return null;
  }
}

const SEVERITY: Record<RiskLevel, number> = { safe: 0, warning: 1, block: 2 };

/** The stricter of the two. Mirrors the server's clamp so the UI cannot show a
 *  weaker verdict than the one the server settled on. */
export function effectiveLevel(rule: RiskLevel, advisory: Advisory | null): RiskLevel {
  if (!advisory) return rule;
  return SEVERITY[advisory.level] > SEVERITY[rule] ? advisory.level : rule;
}
