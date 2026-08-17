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

/** The one change that would make this transfer possible. */
export type RefusalFix =
  | { kind: 'switchSource'; chain: string; label: string }
  | { kind: 'deposit'; amount: bigint; display: string }
  | { kind: 'useMax'; amount: bigint; display: string };

export interface Refusal {
  /** A key into the app's own strings, so this module holds no English. */
  code: 'gwNoBalanceHere' | 'gwEnoughOn' | 'gwShort' | 'shortWithFee' | 'shortWithGas' | 'noGas';
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

/**
 * The most a Gateway balance on one chain can actually send.
 *
 * The fee comes off the top because the balance has to cover the amount *and* the
 * fee, so offering the whole balance as Max produces the one figure guaranteed to
 * be refused. What comes off is the signed ceiling rather than the quoted fee: the
 * signature authorises the ceiling, so subtracting the quote leaves a figure still
 * short by the margin, and Max would fill in an amount that trips the very warning
 * it exists to avoid.
 *
 * This is only sound because Circle prices a Gateway spend flat, the same fee for 1
 * USDC as for 200 on the same route. A proportional fee would make it circular.
 */
export function maxGatewaySpendable(here: bigint, feeCeiling: bigint): bigint {
  const max = here - feeCeiling;
  return max > 0n ? max : 0n;
}

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
 * Whether a Gateway balance can cover the transfer.
 *
 * The comparison is against the source chain's deposit, not the total across
 * chains. Circle reads the balance as one figure but spends it per chain: an intent
 * carries a single source domain and draws only on what was deposited there.
 * Checking the sum lets the check pass, the user sign, and Circle refuse
 * afterwards, which is the exact opposite of what this exists to prevent.
 *
 * When the money is simply on another chain the fix is to switch, not to deposit:
 * "you have 50 USDC" and "you have 50 USDC somewhere this transfer cannot reach"
 * are different problems.
 */
export function gatewayShortfall(params: {
  /** The Gateway balance on the source chain. */
  here: bigint;
  /** Every chain that holds something, keyed the way the app keys chains. */
  byChain: Record<string, bigint>;
  from: string;
  fromLabel: string;
  /** amount + fee ceiling: what the balance has to cover. */
  committed: bigint;
  labelOf: (chain: string) => string;
}): Refusal | null {
  const { here, byChain, from, fromLabel, committed, labelOf } = params;
  if (here >= committed) return null;

  /*
   * The switch is only offered when the other chain can actually cover this
   * transfer. Offering the richest chain that merely holds *something* is how a
   * user with 3.34 here and 1.55 there is told to move to the 1.55, which does not
   * fix the refusal and undoes a choice they made. A fix that does not fix it is
   * worse than no fix, because it is the one thing on screen that looks like a way
   * out.
   */
  let best: string | null = null;
  let most = 0n;
  for (const [chain, amount] of Object.entries(byChain)) {
    if (chain === from || amount < committed) continue;
    if (amount > most) {
      most = amount;
      best = chain;
    }
  }
  if (best) {
    return {
      // Two sentences, because "you have none here" and "you are short here" are
      // different facts and only one of them is true at a time.
      code: here === 0n ? 'gwNoBalanceHere' : 'gwEnoughOn',
      params: {
        chain: fromLabel,
        other: labelOf(best),
        amount: usdc(most),
        missing: usdc(committed - here),
      },
      fix: { kind: 'switchSource', chain: best, label: labelOf(best) },
    };
  }

  const missing = committed - here;
  return {
    code: 'gwShort',
    params: { chain: fromLabel, amount: usdc(missing) },
    fix: { kind: 'deposit', amount: missing, display: usdc(missing) },
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
