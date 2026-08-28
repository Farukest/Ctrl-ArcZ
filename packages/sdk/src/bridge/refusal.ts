/**
 * Why a bridge cannot be sent, worked out before anything is signed.
 *
 * A refusal is not a failure: nothing was attempted, and the form can be moved out
 * of it, usually with one tap. That is the whole reason this is separate from an
 * error. Each one carries the change that would fix it, so the user is not sent off
 * to find a chain picker or to work out an amount themselves.
 *
 * All of it is arithmetic over figures the screen already has, so the form can ask
 * on every keystroke. Asking only inside submit is how the answer arrives after the
 * wallet has been opened rather than while the amount is still being typed.
 */

import { spendableAfterGas } from '../transfer/gas.js';

/**
 * The one change that would make this transfer possible.
 *
 * `switchSource` used to be here, back when a Gateway spend drew on one chain
 * and the fix for money sitting elsewhere was to go and stand on that chain.
 * A spend now draws on every chain at once, so there is nothing left to switch
 * to: whatever the allocator could reach, it already reached.
 */
export type RefusalFix =
  | { kind: 'deposit'; amount: bigint; display: string }
  | { kind: 'useMax'; amount: bigint; display: string };

export interface Refusal {
  /** A key into the app's own strings, so this module holds no English. */
  code: 'gwShort' | 'gwStranded' | 'shortWithFee' | 'shortWithGas' | 'noGas';
  /** Filled into the string for `code`. Amounts are already formatted for reading. */
  params: Record<string, string>;
  fix?: RefusalFix;
}

/** USDC subunits as a plain decimal string, trimmed, for a sentence. */
export function usdc(subunits: bigint, decimals = 6): string {
  const unit = 10n ** BigInt(decimals);
  const neg = subunits < 0n;
  const v = neg ? -subunits : subunits;
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/*
 * `maxGatewaySpendable(here, feeCeiling)` used to live here: one chain's balance
 * less one fee. It is gone rather than deprecated, because a Gateway spend now
 * draws on every chain at once and the honest ceiling has to hold back a base
 * fee per chain and one forwarding fee for the transfer. That is
 * `maxDeliverable()` in `allocate.ts`, and keeping a second, smaller answer
 * exported beside it is how a Max button ends up offering a figure the allocator
 * would refuse.
 */

/**
 * The most that can be moved into Gateway from a chain's wallet balance.
 *
 * On a chain that charges gas in USDC, the whole balance is an amount that cannot
 * pay for its own transaction, so a reserve stays behind.
 */
export function maxDepositable(walletBalance: bigint, gasReserve: bigint): bigint {
  return spendableAfterGas(walletBalance, gasReserve);
}

/**
 * Whether a Gateway balance can cover the transfer, across every chain it sits on.
 *
 * This used to compare the amount against the source chain's deposit alone,
 * because a spend drew on one chain and money elsewhere was money the transfer
 * could not reach. It can reach it now: `allocate()` splits the payment over as
 * many chains as it needs and they are signed together as one `BurnIntentSet`.
 * So the question changed from "is there enough here" to "is there enough
 * anywhere", and the answer comes from the allocator rather than being worked
 * out a second time here -- two places deciding whether a transfer is possible
 * is how a disabled button ends up under an encouraging sentence.
 *
 * Two ways to be short, and they need different sentences because they need
 * different actions:
 *
 *   - **Short outright.** The balance across every chain does not add up.
 *     Deposit the difference.
 *   - **Spread too thin.** The balance adds up, but each chain pays its own base
 *     fee and one of them pays the forwarding fee, so what can actually be
 *     delivered is less than what the balance screen shows. Telling this user to
 *     deposit would be telling them to solve a problem they do not have; the fix
 *     is to send what fits.
 */
export function gatewayShortfall(params: {
  /** What `allocate()` could not cover, in subunits. Zero means the split works. */
  shortfall: bigint;
  /** The Gateway balance across every chain, for telling the two cases apart. */
  total: bigint;
  /** What the recipient is meant to receive. */
  amount: bigint;
  /** `maxDeliverable()`: everything that can be sent once every fee is held back. */
  deliverable: bigint;
}): Refusal | null {
  const { shortfall, total, amount, deliverable } = params;
  if (shortfall <= 0n) return null;

  /*
   * "You hold enough and still cannot send it" is a sentence nobody believes
   * without the reason attached, so it carries both figures: what is there and
   * what survives the fees. The deposit fix is deliberately absent -- depositing
   * more into a balance already large enough is the one action that does not
   * help.
   */
  if (total >= amount && deliverable > 0n) {
    return {
      code: 'gwStranded',
      params: { total: usdc(total), amount: usdc(deliverable) },
      fix: { kind: 'useMax', amount: deliverable, display: usdc(deliverable) },
    };
  }

  return {
    code: 'gwShort',
    params: { amount: usdc(shortfall) },
    fix: { kind: 'deposit', amount: shortfall, display: usdc(shortfall) },
  };
}

/**
 * Whether the wallet can afford a CCTP burn, fee and gas included.
 *
 * Two shapes, because Arc pays gas in USDC and every other chain does not. On Arc
 * one balance has to cover the transfer, the fee and the gas; elsewhere USDC covers
 * the first two and the native token covers the third, and running out of either is
 * a different sentence with a different fix.
 */
export function cctpShortfall(params: {
  usdcBalance: bigint;
  /** amount + maxFee. */
  total: bigint;
  maxFee: bigint;
  /** Gas for the burn, in the chain's native units. */
  gasCost: bigint;
  nativeBalance: bigint;
  chainLabel: string;
  /** True when the chain's gas token is USDC, so both come out of one balance. */
  gasInUsdc: boolean;
  /** Native subunits per USDC subunit, for a chain that charges gas in USDC. */
  nativePerUsdc?: bigint;
  nativeSymbol?: string;
}): Refusal | null {
  const {
    usdcBalance,
    total,
    maxFee,
    gasCost,
    nativeBalance,
    chainLabel,
    gasInUsdc,
    nativePerUsdc = 1_000_000_000_000n,
    nativeSymbol = 'ETH',
  } = params;

  if (gasInUsdc) {
    // One balance, two units. Rounded up: rounding gas down is how a check like this
    // passes a wallet that then cannot send the transaction it just approved.
    const gasAsUsdc = (gasCost + nativePerUsdc - 1n) / nativePerUsdc;
    if (usdcBalance < total + gasAsUsdc) {
      const affordable = usdcBalance - gasAsUsdc - maxFee;
      return {
        code: 'shortWithGas',
        params: { chain: chainLabel, amount: usdc(total + gasAsUsdc - usdcBalance) },
        ...(affordable > 0n
          ? { fix: { kind: 'useMax' as const, amount: affordable, display: usdc(affordable) } }
          : {}),
      };
    }
    return null;
  }

  if (usdcBalance < total) {
    const affordable = usdcBalance - maxFee;
    return {
      code: 'shortWithFee',
      params: { chain: chainLabel, amount: usdc(total - usdcBalance) },
      ...(affordable > 0n
        ? { fix: { kind: 'useMax' as const, amount: affordable, display: usdc(affordable) } }
        : {}),
    };
  }

  if (nativeBalance < gasCost) {
    // No fix to offer: this app cannot put gas in someone's wallet, and pointing at
    // a faucet it has not verified would be worse than saying nothing.
    return {
      code: 'noGas',
      params: { chain: chainLabel, symbol: nativeSymbol },
    };
  }

  return null;
}

/**
 * A fraction of what can actually be sent, as the string the amount field holds.
 *
 * Percentages are of the spendable figure, not of the balance: on Gateway the fee
 * comes out of the same balance, so 100% of the balance is an amount that is always
 * refused. Truncated rather than rounded, because rounding up produces a figure a
 * hair above what is affordable.
 */
export function percentOf(maxSpendable: bigint, fraction: number, decimals = 6): string {
  if (maxSpendable <= 0n || fraction <= 0) return '';
  const scaled = (maxSpendable * BigInt(Math.round(fraction * 10_000))) / 10_000n;
  return usdc(scaled, decimals);
}
