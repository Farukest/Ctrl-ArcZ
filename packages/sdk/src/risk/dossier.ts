import type { Address, PublicClient } from 'viem';
import { erc20Abi } from 'viem';
import { AFFIX_LENGTH } from './rules.js';
import type { IDataProvider, RiskLevel, RiskReport } from './types.js';

/**
 * A dossier is everything worth knowing about a recipient, gathered in one place
 * so something can reason over it.
 *
 * The rule engine deliberately answers one question at a time and answers it the
 * same way every time — that is what makes it trustworthy, and it is not going to
 * change. What it cannot do is weigh several weak signals together. It says "this
 * address has no on-chain history" whether the recipient is a colleague's fresh
 * wallet or a contract that will swallow the money forever, because from a
 * single rule's point of view those look identical.
 *
 * This module collects the signals a rule cannot combine. It draws no conclusion
 * — {@link clampVerdict} governs what any consumer is allowed to do with it.
 */

export interface Dossier {
  sender: Address;
  target: Address;

  /** The rule engine's verdict. Always the floor; nothing may go below it. */
  ruleLevel: RiskLevel;
  ruleCodes: string[];
  ruleComplete: boolean;

  target_: {
    /** True when the address has code. Sending USDC to a contract that cannot
     *  forward it is a permanent loss, and no rule looks for this. */
    isContract: boolean;
    transactionCount: number;
    firstSeenAt: string | null;
    ageHours: number | null;
    /** USDC the address currently holds, in base units, as a decimal string. */
    usdcBalance: string;
    /** Zero-value transfers this address sent the sender: classic poisoning bait. */
    baitToSender: number;
  };

  senderContext: {
    /** How many addresses the sender has actually paid. */
    counterpartyCount: number;
    /**
     * Counterparties the target *nearly* collides with: it shares a shorter affix
     * than the lookalike rule requires. Below the rule's threshold on purpose —
     * one near miss is noise, several at once is a pattern.
     */
    nearMisses: { counterparty: Address; sharedPrefix: number; sharedSuffix: number }[];
  };
}

/** Longest common prefix of the two address bodies, in hex characters. */
function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function sharedSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

const body = (a: Address) => a.toLowerCase().slice(2);

/**
 * Near misses against the sender's own counterparties.
 *
 * The lookalike rule fires on an exact {@link AFFIX_LENGTH} match at both ends and
 * blocks. What lands here is everything just underneath that bar — a 2 or 3
 * character collision at both ends. Any one of those happens by chance
 * constantly, which is exactly why it must never be a rule on its own: it would
 * block honest payments all day. Several of them at once, against the same
 * sender, is what a campaign grinding addresses looks like.
 */
export function findNearMisses(
  target: Address,
  counterparties: Address[],
): Dossier['senderContext']['nearMisses'] {
  const t = body(target);
  const out: Dossier['senderContext']['nearMisses'] = [];
  for (const c of counterparties) {
    const cb = body(c);
    if (cb === t) continue; // the same address is not a near miss
    const p = sharedPrefix(t, cb);
    const s = sharedSuffix(t, cb);
    // Both ends have to collide to be interesting, and an exact match at both is
    // the rule engine's job, not this one's.
    if (p >= 2 && s >= 2 && !(p >= AFFIX_LENGTH && s >= AFFIX_LENGTH)) {
      out.push({ counterparty: c, sharedPrefix: p, sharedSuffix: s });
    }
  }
  return out.sort((a, b) => b.sharedPrefix + b.sharedSuffix - (a.sharedPrefix + a.sharedSuffix));
}

export interface BuildDossierOptions {
  publicClient: PublicClient;
  provider: IDataProvider;
  usdcAddress: Address;
  /** Counterparties, if the caller already has them (the co-signer's index does). */
  counterparties?: Address[];
  now?: Date;
}

/**
 * Gather the dossier. Every lookup is best-effort and independently guarded: a
 * dossier missing a field is still useful, and a failure here must never be able
 * to change a verdict, because nothing in this module is allowed to lower one.
 */
export async function buildDossier(
  report: RiskReport,
  opts: BuildDossierOptions,
): Promise<Dossier> {
  const { publicClient, provider, usdcAddress } = opts;
  const now = opts.now ?? new Date();
  const target = report.target;

  const [code, usdcBalance, activity, bait, counterparties] = await Promise.all([
    publicClient.getCode({ address: target }).catch(() => undefined),
    publicClient
      .readContract({ address: usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [target] })
      .catch(() => 0n),
    provider.getAddressActivity(target).catch(() => ({ transactionCount: 0, firstSeenAt: null })),
    provider.countZeroValueTransfers(target, report.sender).catch(() => 0),
    opts.counterparties
      ? Promise.resolve(opts.counterparties)
      : provider
          .getOutgoingCounterparties(report.sender)
          .then((s) => s.counterparties)
          .catch(() => [] as Address[]),
  ]);

  const firstSeenAt = activity.firstSeenAt;
  return {
    sender: report.sender,
    target,
    ruleLevel: report.level,
    ruleCodes: report.reasons.map((r) => r.code),
    ruleComplete: report.complete,
    target_: {
      isContract: Boolean(code && code !== '0x'),
      transactionCount: activity.transactionCount,
      firstSeenAt: firstSeenAt ? firstSeenAt.toISOString() : null,
      ageHours: firstSeenAt
        ? Math.max(0, Math.round((now.getTime() - firstSeenAt.getTime()) / 3_600_000))
        : null,
      usdcBalance: (usdcBalance as bigint).toString(),
      baitToSender: bait,
    },
    senderContext: {
      counterpartyCount: counterparties.length,
      nearMisses: findNearMisses(target, counterparties),
    },
  };
}

// ---------------------------------------------------------------------------
// The safety property
// ---------------------------------------------------------------------------

const SEVERITY: Record<RiskLevel, number> = { safe: 0, warning: 1, block: 2 };

export interface Advisory {
  level: RiskLevel;
  headline: string;
  points: string[];
}

/**
 * Clamp an advisory so it can only ever make a verdict stricter.
 *
 * This is the whole security argument for putting a language model anywhere near
 * a payment. The rule engine's verdict is a floor: an advisory may raise it, and
 * may never lower it. So the worst a wrong, confused, or prompt-injected
 * investigator can do is refuse a payment that would have been fine — annoying,
 * recoverable, and the direction this product already errs in. It cannot approve
 * anything, cannot un-block a lookalike, and cannot turn a caution into a green
 * light, because the only operation available to it is `max`.
 *
 * On-chain text (token names, contract names, ENS-like labels) is attacker-
 * controlled. It reaches the model as data inside a structured dossier, never as
 * instructions, and the model's reply is constrained to this shape — but none of
 * that is what makes this safe. The clamp is.
 */
export function clampVerdict(ruleLevel: RiskLevel, advisory: Advisory): Advisory {
  return SEVERITY[advisory.level] > SEVERITY[ruleLevel]
    ? advisory
    : { ...advisory, level: ruleLevel };
}
