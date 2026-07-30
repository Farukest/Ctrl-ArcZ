import type { Address } from 'viem';
import type { RiskLevel } from '@ctrl-arcz/sdk';
import type { Session } from '@ctrl-arcz/demo-kit';
import { signedPost } from './signedPost.js';

/**
 * Ask the server for a reasoned second opinion on a recipient.
 *
 * The rule engine has already run in the browser and its verdict stands on its
 * own. This adds context the rules cannot produce — whether the address is a
 * contract, whether it nearly collides with several people you have paid — and
 * it is allowed to make the verdict stricter, never looser. The server clamps
 * that before replying, so nothing here can weaken a block.
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
    const res = await signedPost<{ advisory: Advisory | null }>(session, '/api/investigate', {
      target,
    });
    return res.advisory ?? null;
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
