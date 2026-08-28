/**
 * The arithmetic behind the Gateway source rows, with no React in it.
 *
 * It lives apart from the component because it is the part that was got wrong
 * twice, in ways a screenshot does not show: once by adding a source without
 * trimming the one it was helping, which turned a 12 USDC payment into an 18 one,
 * and once by trimming too hard, which quietly dropped an 11 USDC payment to 7.89.
 *
 * Both of those bugs are now unreachable rather than fixed. The payment is one
 * figure typed once, and the rows are how it gets divided; nothing adds them up,
 * so nothing can add them up wrong. What survives here is the part that is still
 * a judgement: what a chain can spare, and what to offer when the chains listed
 * cannot carry the payment.
 */
import {
  allocate,
  maxDeliverable,
  COSTLY_BASE_FEE,
  type Allocation,
  type AllocationLeg,
  type GatewayChain,
  type SourceBalance,
} from '@ctrl-arcz/sdk';

/**
 * One source row: a chain, and how much of the payment it carries.
 *
 * An empty `amount` means the allocator decides, which is the normal case and
 * the reason multi-source is bearable at all: someone adding a second network
 * should not then have to do division. A non-empty one is the user overruling
 * it for that chain, and is passed to `allocate` as a pin, which is taken
 * literally: not reordered out of existence, not trimmed to fit.
 */
export interface GatewaySource {
  chain: GatewayChain;
  /**
   * As typed, or empty for automatic. A string, because "1." is a thing a field
   * holds mid-keystroke, and because empty has to be distinguishable from zero:
   * zero is "this chain pays nothing", empty is "you decide".
   */
  amount: string;
}

/** The rows the user has fixed by hand, in the shape `allocate` pins. */
export function pinsOf(sources: readonly GatewaySource[]): AllocationLeg[] {
  return sources
    .map((s) => ({ chain: s.chain, value: typedSubunits(s.amount) }))
    .filter((p) => p.value > 0n);
}

/**
 * The split behind a set of rows: one call, made in one place.
 *
 * The rows, the shortfall note, the offer, the cost block, the destination card
 * and the send button all need this answer, and the only way to guarantee they
 * agree is for all of them to be looking at the same one. The screen has already
 * been caught arguing with its own send button once, when a component recomputed
 * a chain's capacity beside the allocator instead of asking it.
 */
export function planFor(opts: {
  /** What the recipient should receive. */
  amount: bigint;
  sources: readonly GatewaySource[];
  balances: readonly SourceBalance[];
  forwarding: bigint;
}): Allocation {
  const listed = new Set(opts.sources.map((s) => s.chain));
  return allocate({
    amount: opts.amount,
    balances: opts.balances,
    forwarding: opts.forwarding,
    allow: (c) => listed.has(c),
    pinned: pinsOf(opts.sources),
    /*
     * Every network the user listed gets used, even where one could have carried
     * the payment alone. Left to itself the allocator packs into as few legs as it
     * can, because an extra leg is an extra base fee for nothing -- correct when
     * it is choosing, and wrong the moment somebody has added a chain on purpose.
     * Adding Base and watching Base contribute zero is the same broken promise as
     * a checkbox that changes nothing.
     */
    spread: opts.sources.length > 1,
  });
}

/** Subunits from a half-typed field. Anything unreadable is nothing, not an error. */
export function typedSubunits(typed: string): bigint {
  const n = Number(typed);
  return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
}

/**
 * What one chain could contribute on its own, its fees held back.
 *
 * `allow` is opened up because the question is what this chain *can* pay, not
 * whether the allocator would pick it. By default `maxDeliverable` refuses
 * anything past the costly threshold, which is the right answer when choosing a
 * split and the wrong one when reporting a balance: it made Ethereum, holding
 * 500 USDC, report a capacity of zero, so the screen offered to top up rather
 * than to use the money sitting there.
 */
export function capacityOf(balance: SourceBalance, forwarding: bigint): bigint {
  return maxDeliverable({ balances: [balance], forwarding, allow: () => true });
}

/**
 * One network you could add, and what adding it would actually do.
 *
 * `fee` is the point. It is not this chain's base fee, it is the total fee of the
 * plan that results from adding it, which is a different and much more useful
 * number: a cheap chain holding too little forces a third leg and ends up costing
 * more than one dearer chain that finishes the job in two. Ranking on the per-leg
 * fee gets that backwards, and ranking on the balance gets it backwards a
 * different way.
 */
export interface CandidateRank {
  chain: GatewayChain;
  /** What Circle reports on this chain. */
  balance: bigint;
  /** What it could contribute once its own fees are held back. Zero is dust. */
  room: bigint;
  /** Adding it makes the payment go through. */
  completes: boolean;
  /** The whole plan's fee once it is added, not this leg's share of it. */
  fee: bigint;
  /** What would still be missing afterwards. Zero when {@link completes}. */
  stillShort: bigint;
  /**
   * How good an answer this is, as a rank rather than a threshold.
   *
   * Absolute fee thresholds are useless here: base fees span a factor of a
   * thousand, from a thousandth of a cent on Unichain to a whole USDC on
   * Ethereum, so any number picked as "expensive" is wrong on most balance
   * sheets. Position against the best available option is not.
   */
  tone: 'best' | 'good' | 'costly' | 'short';
}

/** Above this multiple of the cheapest working plan, a choice is worth flagging. */
const COSTLY_RATIO_NUM = 3n;

/**
 * Every network that could be added, in the order they are worth adding.
 *
 * Each candidate is priced by actually running the split it would produce, rather
 * than by a rule of thumb about it. That is what lets the ranking answer the
 * question people actually have -- "which of these should I pick" -- in a domain
 * where the obvious heuristics are wrong: sending 7 with 6 on Arc, 0.5 on Base and
 * 1.1 on OP, Base is cheaper per leg and OP is the right answer, because Base
 * leaves the payment short and OP finishes it.
 *
 * Cheap to do: `allocate` is a pure function over a snapshot with no I/O, and
 * there are at most ten candidates.
 */
export function rankCandidates(opts: {
  amount: bigint;
  sources: readonly GatewaySource[];
  balances: readonly SourceBalance[];
  forwarding: bigint;
}): CandidateRank[] {
  const listed = new Set(opts.sources.map((s) => s.chain));
  const rows = opts.balances
    .filter((b) => !listed.has(b.chain))
    .map((b) => {
      const withIt = planFor({
        ...opts,
        sources: [...opts.sources, { chain: b.chain, amount: '' }],
      });
      const room = capacityOf(b, opts.forwarding);
      return {
        chain: b.chain,
        balance: b.balance,
        room,
        /*
         * A chain with nothing to spare completes nothing, whatever the split
         * says. `allocate` drops a leg it cannot fill, so adding a dust chain to a
         * payment one chain already covers comes back with `shortfall: 0` -- true
         * of the split, and read as "this network finishes it" it is the opposite
         * of the truth. Sei holding four hundredths was being offered in green.
         */
        completes: room > 0n && withIt.shortfall === 0n,
        fee: withIt.fee,
        stillShort: withIt.shortfall,
      };
    });

  rows.sort((a, b) => {
    // Anything that finishes the payment beats anything that does not, however
    // cheap the one that does not.
    if (a.completes !== b.completes) return a.completes ? -1 : 1;
    if (a.completes) {
      if (a.fee !== b.fee) return a.fee < b.fee ? -1 : 1;
    } else if (a.stillShort !== b.stillShort) {
      // Closest to done first: with nothing able to finish it alone, the useful
      // order is which one leaves the least to find elsewhere.
      return a.stillShort < b.stillShort ? -1 : 1;
    }
    // Nothing between them on the payment, so the fuller chain, which is the one
    // more likely to still be useful next time.
    return a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1;
  });

  const best = rows.find((r) => r.completes)?.fee;
  return rows.map((r) => ({
    ...r,
    tone: !r.completes
      ? 'short'
      : /*
         * Expensive against the alternatives, or expensive full stop.
         *
         * The ratio is the useful test almost always. The absolute floor is there
         * for the case where the dear chain is the ONLY one that works: Ethereum
         * finishing a payment for a whole USDC in fees came out ranked first and
         * therefore green, which is the right rank and the wrong colour. It is
         * still the best answer available; it is not a good one.
         */
        r.fee >= COSTLY_BASE_FEE ||
          (best !== undefined && best > 0n && r.fee > best * COSTLY_RATIO_NUM)
        ? 'costly'
        : r === rows[0]
          ? 'best'
          : 'good',
  }));
}

/**
 * What would still be missing after every network has been used.
 *
 * The honest figure for "you need to deposit this much", and it is arrived at by
 * running the split rather than estimating it. The estimate this replaces priced
 * each spare chain as though it would lead the transfer, which means paying the
 * whole forwarding fee -- true of a chain used alone, and pessimistic by exactly
 * that reserve for a chain used second. On a real balance sheet it told the user
 * to deposit 1.478952 while the list beside it, which simulates properly, said
 * adding that same chain would leave 1.425302. Two numbers for one question, the
 * larger one attached to the button that asks for money.
 *
 * Zero means the payment is already reachable, whatever the current rows say: the
 * user has networks left to add and does not need to deposit anything.
 */
export function residualAfterAll(opts: {
  amount: bigint;
  sources: readonly GatewaySource[];
  balances: readonly SourceBalance[];
  forwarding: bigint;
}): bigint {
  if (opts.amount <= 0n) return 0n;
  /*
   * Pins are kept, because they are the user's decision and a deposit figure
   * computed by ignoring them would be a figure for a payment they did not ask
   * for. Everything not already listed is added automatically.
   */
  const listed = new Set(opts.sources.map((s) => s.chain));
  const everything = [
    ...opts.sources,
    ...opts.balances
      .filter((b) => !listed.has(b.chain) && capacityOf(b, opts.forwarding) > 0n)
      .map((b) => ({ chain: b.chain, amount: '' })),
  ];
  return planFor({ ...opts, sources: everything }).shortfall;
}

/** Subunits as a field would hold them: exact, trimmed, never in exponent form. */
export function formatSubunits(subunits: bigint): string {
  return format(subunits);
}

function format(subunits: bigint): string {
  const whole = subunits / 1_000_000n;
  const frac = (subunits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
