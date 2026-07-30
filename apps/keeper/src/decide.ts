import type { Address } from 'viem';

/**
 * The keeper's decision layer. Pure: it reads a snapshot of chain state and
 * returns what to do. It never touches the network, so every rule here is
 * testable without a chain, and the reasons it gives are the reasons it acted.
 *
 * The keeper exists because `reclaimExpired` is nobody's job. The contract lets
 * anyone call it and always returns the money to the original sender, so the
 * refund the product promises is permissionless — but permissionless is not the
 * same as automatic, and until something actually calls it, an unclaimed
 * transfer just sits there.
 */

/** A transfer the keeper is considering, as read from chain. */
export interface Candidate {
  transferId: bigint;
  sender: Address;
  amount: bigint;
  /** Unix seconds. After this, `reclaimExpired` stops reverting. */
  deadline: number;
  /** Only PENDING and LOCKED are reclaimable; the contract reverts on the rest. */
  status: 'NONE' | 'PENDING' | 'CLAIMED' | 'CANCELLED' | 'RECLAIMED' | 'LOCKED';
}

export interface Budget {
  /** The keeper's own USDC balance, in base units. On Arc this is also its gas. */
  balance: bigint;
  /** What one `reclaimExpired` is expected to cost in gas, in base units. */
  gasPerAction: bigint;
  /** Never spend below this. Leaves the keeper able to pull its next salary. */
  reserve: bigint;
  /** Upper bound on actions per tick, so one sweep cannot drain a day's budget. */
  maxActions: number;
}

export type SkipReason =
  | 'not-reclaimable'
  | 'not-expired'
  | 'not-worth-the-gas'
  | 'over-tick-limit'
  | 'out-of-budget';

export interface Decision {
  act: Candidate[];
  skip: { candidate: Candidate; reason: SkipReason }[];
}

/**
 * Decide which expired transfers to reclaim.
 *
 * The economic rule is the one worth explaining. The keeper pays the gas and the
 * money goes to someone else, so it never profits; the question is not "is this
 * profitable" but "does this leave the system better off". Burning 0.02 USDC of
 * gas to return 0.01 USDC destroys value, so the keeper declines. That is also
 * what stops a griefer from creating a swarm of dust transfers to drain the
 * keeper's budget: each one fails the same test.
 *
 * Ordering is by amount, descending. When the budget only covers part of the
 * queue, the money that gets rescued first is the money that matters most, and
 * the rest stay reclaimable for the next tick (or forever — nothing expires a
 * second time).
 */
export function decide(candidates: Candidate[], budget: Budget, nowSeconds: number): Decision {
  const act: Candidate[] = [];
  const skip: Decision['skip'] = [];

  const eligible: Candidate[] = [];
  for (const c of candidates) {
    if (c.status !== 'PENDING' && c.status !== 'LOCKED') {
      skip.push({ candidate: c, reason: 'not-reclaimable' });
    } else if (nowSeconds <= c.deadline) {
      skip.push({ candidate: c, reason: 'not-expired' });
    } else if (c.amount <= budget.gasPerAction) {
      skip.push({ candidate: c, reason: 'not-worth-the-gas' });
    } else {
      eligible.push(c);
    }
  }

  // Rescue the largest first: a partial budget should save the most money it can.
  eligible.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));

  let spendable = budget.balance > budget.reserve ? budget.balance - budget.reserve : 0n;
  for (const c of eligible) {
    if (act.length >= budget.maxActions) {
      skip.push({ candidate: c, reason: 'over-tick-limit' });
    } else if (spendable < budget.gasPerAction) {
      skip.push({ candidate: c, reason: 'out-of-budget' });
    } else {
      act.push(c);
      spendable -= budget.gasPerAction;
    }
  }

  return { act, skip };
}

/**
 * Whether the keeper should draw its next salary, and how much.
 *
 * The keeper is paid the way any other merchant is paid by this product: it
 * pulls from a spend box whose policy is on chain. It asks for exactly what it
 * is short of a full tank, capped by the box's own per-pull limit — so a keeper
 * that has been idle does not accumulate a claim, and a compromised keeper
 * cannot ask for more than the policy already allows. The contract enforces the
 * cap regardless of what this function returns; the check here is so the keeper
 * does not waste gas on a pull the chain would reject.
 */
export function decideSalary(params: {
  balance: bigint;
  /** Top up when the balance falls below this. */
  lowWater: bigint;
  /** Aim for this after a pull. */
  targetBalance: bigint;
  /** The box's per-pull ceiling, from chain. */
  perPullMax: bigint;
  /** What is left of the box's cumulative cap, from chain. */
  remaining: bigint;
  /** The box's own USDC balance — it cannot pay out more than it holds. */
  boxBalance: bigint;
  /** Unix seconds when the next pull becomes allowed (lastPull + interval). */
  nextPullAt: number;
  nowSeconds: number;
}): { pull: false; reason: string } | { pull: true; amount: bigint } {
  if (params.balance >= params.lowWater) return { pull: false, reason: 'balance is fine' };
  if (params.nowSeconds < params.nextPullAt) return { pull: false, reason: 'interval has not elapsed' };

  const want = params.targetBalance > params.balance ? params.targetBalance - params.balance : 0n;
  const amount = min(want, params.perPullMax, params.remaining, params.boxBalance);
  if (amount <= 0n) return { pull: false, reason: 'nothing left to draw' };

  return { pull: true, amount };
}

function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => (a < b ? a : b));
}
