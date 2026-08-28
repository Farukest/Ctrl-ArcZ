/**
 * Which chains a Gateway spend draws from, and in what order.
 *
 * A Gateway balance is one figure spread over several chains, but a transfer
 * spends it per chain: every burn intent names one `sourceDomain` and draws only
 * on what was deposited there. So a wallet holding enough in total can still be
 * unable to pay, and the fix is to draw from more than one chain in the same
 * transfer. Circle accepts up to 16 intents in one request, and on EVM they can
 * be signed together as a `BurnIntentSet`, so the user still signs once however
 * many chains are involved.
 *
 * Everything here is a pure function over a snapshot, so the same inputs give the
 * same split on every platform. That matters: the Android client runs its own
 * port of this, and a split that disagrees between the two is a payment that
 * works on one phone and not the other.
 *
 * The cost model below was measured, not assumed. See {@link GATEWAY_BASE_FEE}.
 */
import type { GatewayChain } from './gateway.js';

/**
 * What one burn intent costs on each source chain, in USDC subunits.
 *
 * Measured 2026-08-26 against Circle's testnet estimate endpoint, pricing a 1
 * USDC leg into Arc from each chain in turn. The spread is the whole reason this
 * module exists: Ethereum is a thousand times Unichain, so "just add another
 * source" is cheap advice on ten chains and ruinous on the eleventh.
 *
 * This is a hint used to CHOOSE a split. The fee that gets signed always comes
 * back from `/v1/estimate`, never from here.
 */
export const GATEWAY_BASE_FEE: Readonly<Record<GatewayChain, bigint>> = {
  Unichain_Sepolia: 1_000n,
  Sei_Testnet: 1_000n,
  OP_Sepolia: 1_500n,
  Polygon_Amoy: 1_500n,
  Arc_Testnet: 3_500n,
  Arbitrum_Sepolia: 10_000n,
  Base_Sepolia: 10_000n,
  Sonic_Testnet: 10_000n,
  World_Chain_Sepolia: 10_000n,
  Avalanche_Fuji: 20_000n,
  Ethereum_Sepolia: 1_000_000n,
};

/**
 * Above this, a chain is expensive enough that using it is the user's decision
 * rather than the allocator's. Only Ethereum clears it today, at 1 USDC a leg,
 * which can exceed the payment it is helping to fund.
 */
export const COSTLY_BASE_FEE = 100_000n;

/**
 * What a leg costs, and what has to be held back for it. They are not the same
 * number, and confusing them is how a Max button produces an amount that is
 * refused by the app's own pre-flight check.
 *
 * Measured 2026-08-26 against `/v1/estimate`, one, two and four legs, at 0.1, 1,
 * 5 and 200 USDC:
 *
 *   - The fee does not depend on the amount at all. Identical for 1 and for 200.
 *   - What is actually charged is the sum of the base fees plus one forwarding
 *     fee. Circle reports exactly that as `fees.total`.
 *   - The `maxFee` Circle suggests per leg is larger: the first leg gets
 *     `baseFee + forwardingFee` on the nose, and every leg after it gets its own
 *     base fee plus a tenth (10000 -> 11000, 1500 -> 1650, 1000 -> 1100).
 *   - On top of that, `spendFromGateway` signs `quoted + max(gasPart, 0.005)`,
 *     so a doubling of gas between quoting and settling still goes through.
 *
 * So the ceiling ends up near twice the charge. Both numbers are kept: `fee` is
 * what the user is told, because it is what leaves their balance, and `ceiling`
 * is what the allocator reserves, because it is what the signature authorises.
 */
const LEG_CEILING_FLOOR = 5_000n; // mirrors FEE_MARGIN_MIN in gateway.ts

/**
 * How stale the forwarding fee is allowed to be before the reserve stops
 * covering it.
 *
 * The screen reads the fee once and then recomputes the split on every
 * keystroke, so by the time anything is signed the figure is seconds to minutes
 * old, and it moves: two percent between two reads in one session and fifteen
 * percent in another. That was not a hypothetical. A real 20 USDC transfer, split
 * Arc 17.008084 + Base 2.991916, filled the Arc leg to the exact subunit of what
 * the allocator thought it could hold; forwarding rose from 0.015897 to 0.018289
 * between the quote that fed the allocator and the quote that was signed, and the
 * spend refused itself with "balance on Arc Testnet is 17.046878 and this
 * transfer draws 17.051662".
 *
 * Widening the reserve costs nothing but a fraction of a cent of Max, because
 * `maxFee` is a ceiling and Circle takes what the transfer actually cost. Not
 * widening it costs a transfer, at the worst possible moment: after the split has
 * been shown as workable.
 */
const FORWARDING_DRIFT_NUM = 3n;
const FORWARDING_DRIFT_DEN = 2n;

function legCeiling(baseFee: bigint, forwarding: bigint): bigint {
  // The gas-bearing part, which is the only part that drifts, allowed room to.
  const gas = baseFee + (forwarding * FORWARDING_DRIFT_NUM) / FORWARDING_DRIFT_DEN;
  const quoted = forwarding > 0n ? gas : (baseFee * 11n) / 10n;
  return quoted + (gas > LEG_CEILING_FLOOR ? gas : LEG_CEILING_FLOOR);
}

/** Circle's cap on one transfer request. */
export const MAX_INTENTS = 16;

/** A chain and what is confirmed and spendable on it right now. */
export interface SourceBalance {
  chain: GatewayChain;
  /** Confirmed only. A deposit still waiting on confirmations is not this. */
  balance: bigint;
}

/** One burn intent's worth: draw `value` from `chain`. */
export interface AllocationLeg {
  chain: GatewayChain;
  value: bigint;
}

export interface Allocation {
  /**
   * Ordered. The first leg carries the whole forwarding fee, so it is the leg
   * with the most room to spare rather than the largest payment.
   */
  legs: AllocationLeg[];
  /**
   * What Circle will actually charge: every base fee plus one forwarding fee.
   * This is the number to show, because it is the number that leaves the
   * balance.
   */
  fee: bigint;
  /**
   * What the signature authorises, which is close to twice {@link fee}. Not a
   * price: Circle takes what the transfer cost and ignores the rest. It is here
   * because it is what the balance has to be able to cover, so it is what
   * feasibility is judged against.
   */
  ceiling: bigint;
  /** What has to be available in total: the amount plus {@link ceiling}. */
  committed: bigint;
  /** Still uncovered. Zero when the split works. */
  shortfall: bigint;
  /**
   * How much more than the amount the legs add up to.
   *
   * Only reachable by pinning: type 5 on two chains while sending 8 and the legs
   * over-deliver by 2. Reported rather than silently trimmed, because trimming
   * would undo a number the user typed on purpose, and delivering it would pay
   * someone more than was meant.
   */
  overfill: bigint;
  /** A leg had to be taken on a chain past {@link COSTLY_BASE_FEE}. */
  costly: boolean;
}

export interface AllocateOptions {
  /** What the recipient should receive, in subunits. */
  amount: bigint;
  balances: readonly SourceBalance[];
  /**
   * The destination's forwarding fee, in subunits, from a recent estimate.
   *
   * It belongs to the transfer rather than to any one source: minting on Arc
   * cost about 0.016 from every source chain measured, and minting on Avalanche
   * about 0.054 from those same chains. It lands entirely on the first leg.
   */
  forwarding: bigint;
  /** Overridable so a caller can price a split against fresher numbers. */
  baseFee?: (chain: GatewayChain) => bigint;
  /**
   * Chains the user has agreed to pay for. Ethereum is excluded by default
   * because a leg there can cost more than the payment; ask first, then pass a
   * predicate that lets it through.
   */
  allow?: (chain: GatewayChain) => boolean;
  maxLegs?: number;
  /**
   * Legs the user set by hand, taken exactly as given.
   *
   * The split is arithmetic and the app is better at it, but which balance gets
   * drained is not arithmetic: someone may be holding USDC on one chain for
   * something this app cannot see, or may simply want a particular chain emptied.
   * A pinned leg is that decision, and it is not second-guessed -- not reordered
   * out of existence, not trimmed to fit, not dropped because a cheaper split
   * exists.
   *
   * Whatever the pins do not cover is filled from the remaining chains, so
   * pinning one leg of three still leaves the other two automatic.
   */
  pinned?: readonly AllocationLeg[];
  /**
   * Share what the pins do not cover across every allowed chain, rather than
   * filling the roomiest and leaving the rest empty.
   *
   * For when the chains were listed by hand. Left to itself the allocator packs
   * the payment into as few legs as it can, because an extra leg is an extra base
   * fee for nothing -- correct when it is choosing, and wrong the moment somebody
   * has added a chain on purpose. Adding Base to a payment one chain could carry
   * and watching Base contribute zero is the same broken promise as a checkbox
   * that changes nothing; the extra fee is the price of an instruction the user
   * gave deliberately.
   */
  spread?: boolean;
}

const defaultBaseFee = (chain: GatewayChain): bigint => GATEWAY_BASE_FEE[chain] ?? 10_000n;

/** Cheap chains first, and on a tie the fuller one, so ties break toward fewer legs. */
function byCost(feeOf: (c: GatewayChain) => bigint) {
  return (a: SourceBalance, b: SourceBalance): number => {
    const fa = feeOf(a.chain);
    const fb = feeOf(b.chain);
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1;
  };
}

/**
 * Pick the chains to draw from.
 *
 * The order of preference is settled by measurement rather than taste:
 *
 *  1. **One leg beats two.** Splitting a payment that one chain could have
 *     carried costs an extra base fee for nothing. Measured: 7 USDC from Base
 *     alone came to 0.026617, while 5 from Arc plus 2 from Base came to
 *     0.032803 for the same delivery.
 *  2. **Among equals, the cheaper chain.** Base fees run from 0.001 to 1.00.
 *  3. **The roomiest leg goes first**, because the forwarding fee is deducted
 *     from the intents in the order they are passed, and a small leg placed
 *     first can end up owing more than it holds.
 *
 * Drawing from the destination chain earns no discount: minting on Base from
 * Base cost more than minting on Base from Arc, purely because Base's own base
 * fee is higher. Only the destination sets the forwarding fee.
 */
export function allocate(opts: AllocateOptions): Allocation {
  const feeOf = opts.baseFee ?? defaultBaseFee;
  const allow = opts.allow ?? ((c: GatewayChain) => feeOf(c) < COSTLY_BASE_FEE);
  const maxLegs = Math.min(opts.maxLegs ?? MAX_INTENTS, MAX_INTENTS);
  const { amount, forwarding } = opts;

  const pins = (opts.pinned ?? []).filter((p) => p.value > 0n);

  const empty: Allocation = {
    legs: [],
    fee: 0n,
    ceiling: 0n,
    committed: 0n,
    shortfall: amount,
    overfill: 0n,
    costly: false,
  };
  if (amount <= 0n) return { ...empty, shortfall: 0n };

  const balanceOf = (chain: GatewayChain): bigint =>
    opts.balances.find((b) => b.chain === chain)?.balance ?? 0n;

  /**
   * Check an ordered set of legs against the chains that have to pay them, and
   * price the result.
   *
   * The order arrives decided and is not touched here. That is deliberate: each
   * path sizes its legs against the position they will hold -- only the first leg
   * has the forwarding fee held back against it -- so re-sorting at the end would
   * invalidate the very arithmetic that produced the values. Ordering in two
   * places is how a leg gets sized as second and then submitted as first.
   *
   * Why the order matters at all: Circle deducts the forwarding fee from the
   * intents in the sequence they are passed, so whatever goes first needs room
   * for it on top of its own value and fee. Measured, a 0.01 leg placed first was
   * charged 0.062893 and the transfer died after it had been signed.
   */
  const done = (legs: readonly AllocationLeg[], overfill: bigint): Allocation => {
    if (legs.length === 0) return { ...empty, overfill };
    if (legs.length > maxLegs) {
      // Past Circle's cap the request is refused outright, so the honest answer
      // is that this split cannot be sent rather than a quietly truncated one.
      return { ...empty, shortfall: amount, overfill };
    }

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i] as AllocationLeg;
      const needs = leg.value + legCeiling(feeOf(leg.chain), i === 0 ? forwarding : 0n);
      const has = balanceOf(leg.chain);
      // Reported against the leg that cannot pay, not against the total: the user
      // has to know which chain is short, and by how much.
      if (has < needs) return { ...empty, shortfall: needs - has, overfill };
    }

    const fee = legs.reduce((sum, l) => sum + feeOf(l.chain), 0n) + forwarding;
    const ceiling = legs.reduce(
      (sum, l, i) => sum + legCeiling(feeOf(l.chain), i === 0 ? forwarding : 0n),
      0n,
    );
    return {
      legs: [...legs],
      fee,
      ceiling,
      committed: legs.reduce((sum, l) => sum + l.value, 0n) + ceiling,
      shortfall: 0n,
      overfill,
      costly: legs.some((l) => feeOf(l.chain) >= COSTLY_BASE_FEE),
    };
  };

  /**
   * What a chain has to spare, once it has paid to be used at all.
   *
   * The reserve is the signed ceiling rather than the fee, because a chain that
   * can pay the fee but not the ceiling is a chain the pre-flight check refuses
   * after the split has already been shown as workable. `first` says whether
   * this leg would also carry the forwarding fee, which roughly triples what a
   * cheap chain has to hold back.
   */
  const roomOn = (b: SourceBalance, first: boolean): bigint =>
    b.balance - legCeiling(feeOf(b.chain), first ? forwarding : 0n);

  // A chain that cannot cover its own reserve can never contribute. Filtering on
  // "has a balance" instead would offer a chain holding 0.004 as a way to make
  // up a shortfall it would only deepen.
  const usable = opts.balances
    .filter((b) => allow(b.chain) && roomOn(b, false) > 0n)
    .sort(byCost(feeOf));

  /*
   * Pinned legs are the user's answer, so the only question left is what is still
   * uncovered. The single-leg preference below is deliberately skipped here: it
   * exists to stop the app splitting a payment one chain could carry, and with a
   * pin the splitting was not the app's idea.
   */
  if (pins.length > 0 || opts.spread) {
    /*
     * The user chose the chains and the amounts; the order is not theirs to get
     * wrong, and they are not shown it. Whichever leg has the most left over
     * after paying its own way is the one that can absorb the forwarding fee, so
     * it leads. This is the one place the order genuinely has to be worked out:
     * the automatic path below builds its list in the right sequence already.
     */
    const leadFirst = (legs: readonly AllocationLeg[]): AllocationLeg[] =>
      [...legs].sort((a, b) => {
        const sa = balanceOf(a.chain) - a.value - feeOf(a.chain);
        const sb = balanceOf(b.chain) - b.value - feeOf(b.chain);
        return sa === sb ? 0 : sa > sb ? -1 : 1;
      });

    const pinnedTotal = pins.reduce((sum, p) => sum + p.value, 0n);
    if (pinnedTotal >= amount) return done(leadFirst(pins), pinnedTotal - amount);

    const spokenFor = new Set(pins.map((p) => p.chain));
    const free = usable.filter((b) => !spokenFor.has(b.chain)).slice(0, maxLegs - pins.length);
    let remaining = amount - pinnedTotal;

    /*
     * Which leg leads is settled here, before anything is divided.
     *
     * The leading leg pays the forwarding fee on top of its own value and base
     * fee, so it has less to give than the others. Splitting first and choosing
     * the leader afterwards produces a division that adds up and is then refused
     * by its own validation, because the chain that ended up first was sized as
     * though it would be second. Measured on OP 4 + Arc 4 sending 7.94: an even
     * 3.97 each, and then OP needed 4.021 of the 4 it holds.
     *
     * The roomiest free chain leads, which is also what `maxDeliverable` assumes
     * when it works out how much these balances can send. The two have to agree
     * or a Max figure is refused by the very split it was calculated for.
     */
    const lead = free.reduce<SourceBalance | null>(
      (best, b) => (best === null || roomOn(b, false) > roomOn(best, false) ? b : best),
      null,
    );

    /*
     * Share the remainder rather than pack it. Each free chain is offered an
     * equal slice, capped by what it can actually hold, and whatever a capped
     * chain could not take is offered round again to the ones with room left.
     * Repeats until the money is placed or nobody can take any more, which
     * terminates because every pass either places something or caps a chain that
     * is then out of the running.
     */
    const taken = new Map<GatewayChain, bigint>();
    let open = free.map((b) => ({ chain: b.chain, room: roomOn(b, b.chain === lead?.chain) }));
    while (remaining > 0n && open.length > 0) {
      const share = remaining / BigInt(open.length);
      // Below one subunit each, an even split cannot make progress; hand what is
      // left to the roomiest and stop.
      if (share === 0n) {
        const best = open.reduce((a, b) => (b.room > a.room ? b : a));
        const value = best.room < remaining ? best.room : remaining;
        taken.set(best.chain, (taken.get(best.chain) ?? 0n) + value);
        remaining -= value;
        break;
      }
      const next: typeof open = [];
      for (const c of open) {
        const value = c.room < share ? c.room : share;
        if (value > 0n) {
          taken.set(c.chain, (taken.get(c.chain) ?? 0n) + value);
          remaining -= value;
        }
        const left = c.room - value;
        if (left > 0n) next.push({ chain: c.chain, room: left });
      }
      open = next;
    }

    if (remaining > 0n) return { ...empty, shortfall: remaining };
    const filled: AllocationLeg[] = free
      .map((b) => ({ chain: b.chain, value: taken.get(b.chain) ?? 0n }))
      // A chain that ended up with nothing is not a leg. A zero-value intent
      // pays a base fee to deliver nothing.
      .filter((l) => l.value > 0n);

    // The leader was chosen and sized above, so it is placed rather than sorted
    // for. Where nothing was left to fill, the pins alone decide the order.
    const leadLeg = filled.find((l) => l.chain === lead?.chain);
    const ordered = leadLeg
      ? [leadLeg, ...filled.filter((l) => l !== leadLeg), ...pins]
      : leadFirst([...pins, ...filled]);
    return done(ordered, 0n);
  }

  // One leg, if any single chain can carry the amount and its whole reserve --
  // its own fee and the forwarding fee, both at the ceiling. `usable` is
  // cheapest-first, so the first match is the best.
  for (const b of usable) {
    if (roomOn(b, true) >= amount) return done([{ chain: b.chain, value: amount }], 0n);
  }

  // More than one leg. Take the fullest chains first so the leg count stays as
  // low as possible, which is what actually drives the cost.
  const byRoom = [...usable].sort((a, b) => {
    const ra = roomOn(a, false);
    const rb = roomOn(b, false);
    return ra === rb ? 0 : ra > rb ? -1 : 1;
  });

  const chosen: SourceBalance[] = [];
  let capacity = 0n;
  for (const b of byRoom) {
    if (chosen.length >= maxLegs) break;
    chosen.push(b);
    // The first chosen chain is the one that will lead the list and so the one
    // that pays for forwarding; the rest hold back only their own reserve.
    capacity = chosen.reduce((sum, c, i) => sum + roomOn(c, i === 0), 0n);
    if (capacity >= amount) break;
  }

  if (capacity < amount) {
    return { ...empty, shortfall: amount - (capacity > 0n ? capacity : 0n) };
  }

  // `byRoom` already leads with the roomiest chain, which is the one that can
  // absorb the forwarding fee without its own leg outgrowing its balance.
  const legs: AllocationLeg[] = [];
  let remaining = amount;
  for (let i = 0; i < chosen.length && remaining > 0n; i++) {
    const b = chosen[i] as SourceBalance;
    const room = roomOn(b, i === 0);
    if (room <= 0n) continue;
    const value = room < remaining ? room : remaining;
    legs.push({ chain: b.chain, value });
    remaining -= value;
  }

  if (remaining > 0n) return { ...empty, shortfall: remaining };

  return done(legs, 0n);
}

/**
 * The most this balance can actually deliver, across every chain it sits on.
 *
 * Not the sum of the balances: each leg pays its own base fee and the transfer
 * pays one forwarding fee, so the deliverable figure is always smaller than the
 * number a balance screen shows. This is what a "Max" button should fill in.
 */
export function maxDeliverable(opts: Omit<AllocateOptions, 'amount'>): bigint {
  const feeOf = opts.baseFee ?? defaultBaseFee;
  const allow = opts.allow ?? ((c: GatewayChain) => feeOf(c) < COSTLY_BASE_FEE);
  const maxLegs = Math.min(opts.maxLegs ?? MAX_INTENTS, MAX_INTENTS);
  const roomOn = (b: SourceBalance, first: boolean): bigint =>
    b.balance - legCeiling(feeOf(b.chain), first ? opts.forwarding : 0n);

  const usable = opts.balances
    .filter((b) => allow(b.chain) && roomOn(b, false) > 0n)
    .sort((a, b) => {
      const ra = roomOn(a, false);
      const rb = roomOn(b, false);
      return ra === rb ? 0 : ra > rb ? -1 : 1;
    })
    .slice(0, maxLegs);

  // Held back at the ceiling rather than at the fee, so that what this returns
  // is an amount `allocate` will accept. A Max that the very next check refuses
  // is worse than no Max button, because it looks like the app disagreeing with
  // itself.
  let total = 0n;
  for (let i = 0; i < usable.length; i++) total += roomOn(usable[i] as SourceBalance, i === 0);
  return total > 0n ? total : 0n;
}
