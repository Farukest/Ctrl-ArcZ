/**
 * When a person's decision to proceed is allowed to outrank the firewall.
 *
 * The firewall refuses by default and that is the point of it. But a rule engine
 * can be wrong, and it is wrong in a way that costs a real user real money: the
 * lookalike rule fires on eight matching hex characters, which two unrelated
 * addresses can share by accident, and the zero-value rule fires on a transfer
 * anyone can send you. A refusal with no way past it is a product that sometimes
 * simply cannot pay a colleague, and the person on the other side of that has no
 * recourse and no explanation that helps.
 *
 * So there is a way past it, built on one idea: the acknowledgement has to prove
 * the user was shown the specific thing they are overriding. It carries the
 * report, not a flag. A caller cannot set `override: true` once and have it apply
 * to every future send, and cannot acknowledge a mild verdict and ride it through
 * a worse one.
 *
 * What this deliberately does not do is make the refusal cheap. That part is the
 * caller's: the app that asks for this shows the two addresses side by side
 * first, because a poisoning victim is certain, and certainty is not fixed by a
 * button. It is fixed by looking.
 */
import type { RiskReport, RiskRuleCode } from './types.js';

/**
 * How long a decision stays good for.
 *
 * Measured from when the person decided, not from when the scan ran. Those are
 * different clocks and using the wrong one breaks the feature: a protected send
 * registers a config and approves an allowance first, two transactions with a
 * wallet confirmation each, so by the time the guard is reached the scan behind
 * the decision is minutes old through no fault of the user. Fifteen minutes is
 * long enough to cover that and short enough that a decision does not outlive
 * the session it was made in.
 *
 * Nothing is lost by being generous here, because staleness is not what this
 * protects against. The guard re-scans any report older than `MAX_REPORT_AGE_MS`
 * and judges the acknowledgement against that fresh verdict, so a bait transfer
 * landing after the user looked shows up as a new reason and voids the decision
 * regardless of how recent the decision itself was.
 */
export const MAX_ACKNOWLEDGEMENT_AGE_MS = 15 * 60 * 1000;

/**
 * A verdict someone looked at and chose to proceed past, and when they chose.
 */
export interface RiskAcknowledgement {
  /** Exactly what was on screen when they decided. */
  report: RiskReport;
  /** Epoch ms of the decision itself. */
  at: number;
}

const RANK: Record<RiskReport['level'], number> = { safe: 0, warning: 1, block: 2 };

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function codes(report: RiskReport): Set<RiskRuleCode> {
  return new Set(report.reasons.map((r) => r.code));
}

/**
 * Does this acknowledgement cover the verdict actually in force?
 *
 * Four conditions, each closing a way the override could be stretched past what
 * the user agreed to:
 *
 *   - **Same pair.** An acknowledgement for one recipient says nothing about
 *     another.
 *   - **Still recent.** A decision is not permission held forever.
 *   - **No worse.** If the verdict escalated between the decision and the send,
 *     they agreed to something milder than what is true now.
 *   - **No new reasons.** A verdict can gain a reason without changing level. The
 *     user has to have been shown every reason that is now in force.
 */
export function acknowledgementCovers(
  acknowledgement: RiskAcknowledgement,
  actual: RiskReport,
  now: number = Date.now(),
): boolean {
  const { report: acknowledged, at } = acknowledgement;
  if (!sameAddress(acknowledged.sender, actual.sender)) return false;
  if (!sameAddress(acknowledged.target, actual.target)) return false;
  if (now - at > MAX_ACKNOWLEDGEMENT_AGE_MS) return false;
  if (RANK[actual.level] > RANK[acknowledged.level]) return false;

  const seen = codes(acknowledged);
  return actual.reasons.every((r) => seen.has(r.code));
}
