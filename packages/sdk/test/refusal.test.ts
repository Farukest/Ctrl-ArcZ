import { describe, expect, it } from 'vitest';
import {
  cctpShortfall,
  gatewayShortfall,
  maxDepositable,
  maxGatewaySpendable,
  percentOf,
  usdc,
} from '../src/index.js';

/**
 * Refusing a bridge before anything is signed.
 *
 * Every case here is one a user hits with money on the line, and the failure mode
 * they share is a check that passes and lets Circle refuse afterwards -- once the
 * wallet has been opened, an allowance approved, or a deposit made. So the tests
 * lean on the boundaries: exactly enough, one subunit short, the fee that is larger
 * than the transfer, the balance that is on the wrong chain.
 */

const M = 1_000_000n; // one USDC

describe('usdc', () => {
  it('trims without losing precision', () => {
    expect(usdc(0n)).toBe('0');
    expect(usdc(M)).toBe('1');
    expect(usdc(1_500_000n)).toBe('1.5');
    expect(usdc(1n)).toBe('0.000001');
    expect(usdc(1_000_001n)).toBe('1.000001');
    // A borrowed figure can be negative while a shortfall is being worked out.
    expect(usdc(-1_500_000n)).toBe('-1.5');
  });

  it('does not drop a zero inside the fraction', () => {
    // "1.05" trimmed carelessly becomes "1.5", which is twenty times the number.
    expect(usdc(1_050_000n)).toBe('1.05');
    expect(usdc(1_000_010n)).toBe('1.00001');
  });
});

describe('maxGatewaySpendable', () => {
  it('takes the fee off the top', () => {
    expect(maxGatewaySpendable(10n * M, 55_000n)).toBe(9_945_000n);
  });

  it('is zero rather than negative when the fee exceeds the balance', () => {
    // A negative max would be formatted into the amount field as "-0.05".
    expect(maxGatewaySpendable(10_000n, 55_000n)).toBe(0n);
  });

  it('is zero at exactly the fee', () => {
    expect(maxGatewaySpendable(55_000n, 55_000n)).toBe(0n);
  });

  it('leaves nothing behind that the ceiling does not need', () => {
    // What it returns has to be sendable: spendable + ceiling == balance exactly.
    const balance = 3_342_506n;
    const ceiling = 55_447n;
    expect(maxGatewaySpendable(balance, ceiling) + ceiling).toBe(balance);
  });
});

describe('maxDepositable', () => {
  it('keeps back the gas reserve', () => {
    expect(maxDepositable(100n * M, 10_000n)).toBe(99_990_000n);
  });

  it('is zero when the reserve is the whole balance', () => {
    expect(maxDepositable(10_000n, 10_000n)).toBe(0n);
    expect(maxDepositable(5_000n, 10_000n)).toBe(0n);
  });

  it('keeps nothing back where gas is not USDC', () => {
    expect(maxDepositable(100n * M, 0n)).toBe(100n * M);
  });
});

describe('gatewayShortfall', () => {
  const labelOf = (c: string) => c.replace(/_/g, ' ');

  it('passes when the balance covers the commitment exactly', () => {
    expect(
      gatewayShortfall({
        here: 5n * M,
        byChain: { Arc_Testnet: 5n * M },
        from: 'Arc_Testnet',
        fromLabel: 'Arc Testnet',
        committed: 5n * M,
        labelOf,
      }),
    ).toBeNull();
  });

  it('refuses one subunit short', () => {
    // The case a check against the amount alone would let through: the balance
    // covers the transfer and not the fee, and Circle refuses after signing.
    const r = gatewayShortfall({
      here: 5n * M - 1n,
      byChain: { Arc_Testnet: 5n * M - 1n },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: 5n * M,
      labelOf,
    });
    expect(r?.code).toBe('gwShort');
    expect(r?.params.amount).toBe('0.000001');
    expect(r?.fix).toEqual({ kind: 'deposit', amount: 1n, display: '0.000001' });
  });

  it('offers the chain that holds the money instead of a deposit', () => {
    // Depositing would be the wrong advice: the money exists, it is one tap away.
    const r = gatewayShortfall({
      here: 0n,
      byChain: { Arc_Testnet: 0n, Base_Sepolia: 3n * M },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: M,
      labelOf,
    });
    expect(r?.code).toBe('gwNoBalanceHere');
    expect(r?.fix).toEqual({ kind: 'switchSource', chain: 'Base_Sepolia', label: 'Base Sepolia' });
  });

  it('offers the richest other chain, not the first one found', () => {
    const r = gatewayShortfall({
      here: 0n,
      byChain: { Arc_Testnet: 0n, Base_Sepolia: M, Sonic_Testnet: 9n * M },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: M,
      labelOf,
    });
    expect((r?.fix as { chain: string }).chain).toBe('Sonic_Testnet');
  });

  it('does not offer a chain that cannot cover the transfer either', () => {
    // The case that makes a fix actively harmful: 3.34 here, 1.55 there, and the
    // transfer needs 5. Switching loses the larger balance and refuses again.
    const r = gatewayShortfall({
      here: 3_342_506n,
      byChain: { Arc_Testnet: 3_342_506n, Base_Sepolia: 1_550_000n },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: 5n * M,
      labelOf,
    });
    expect(r?.code).toBe('gwShort');
    expect(r?.fix?.kind).toBe('deposit');
  });

  it('says "short here" rather than "none here" when there is some', () => {
    // Claiming no balance on a chain holding 3.34 is simply false, and the reader
    // checks it against the figure shown one line above.
    const r = gatewayShortfall({
      here: 3n * M,
      byChain: { Arc_Testnet: 3n * M, Base_Sepolia: 9n * M },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: 5n * M,
      labelOf,
    });
    expect(r?.code).toBe('gwEnoughOn');
    expect(r?.params.missing).toBe('2');
    expect(r?.params.amount).toBe('9');
    expect((r?.fix as { chain: string }).chain).toBe('Base_Sepolia');
  });

  it('offers the switch at exactly enough on the other chain', () => {
    const r = gatewayShortfall({
      here: 0n,
      byChain: { Arc_Testnet: 0n, Base_Sepolia: 5n * M },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: 5n * M,
      labelOf,
    });
    expect(r?.code).toBe('gwNoBalanceHere');
    expect(r?.fix?.kind).toBe('switchSource');
  });

  it('asks for a deposit when the other chain is one subunit short', () => {
    const r = gatewayShortfall({
      here: 0n,
      byChain: { Arc_Testnet: 0n, Base_Sepolia: 5n * M - 1n },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: 5n * M,
      labelOf,
    });
    expect(r?.code).toBe('gwShort');
    expect(r?.fix?.kind).toBe('deposit');
  });

  it('does not offer an empty chain', () => {
    // Switching to another empty chain fixes nothing and costs a round trip.
    const r = gatewayShortfall({
      here: 0n,
      byChain: { Arc_Testnet: 0n, Base_Sepolia: 0n },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: M,
      labelOf,
    });
    expect(r?.code).toBe('gwShort');
    expect(r?.fix?.kind).toBe('deposit');
  });

  it('never offers the source chain back to itself', () => {
    // The source has some money, just not enough. Suggesting a switch to where the
    // user already is would be a fix that changes nothing.
    const r = gatewayShortfall({
      here: 2n * M,
      byChain: { Arc_Testnet: 2n * M },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: 5n * M,
      labelOf,
    });
    expect(r?.fix).toEqual({ kind: 'deposit', amount: 3n * M, display: '3' });
  });

  it('asks for exactly what is missing, fee included', () => {
    const r = gatewayShortfall({
      here: 3_342_506n,
      byChain: { Arc_Testnet: 3_342_506n },
      from: 'Arc_Testnet',
      fromLabel: 'Arc Testnet',
      committed: 5n * M + 55_447n,
      labelOf,
    });
    // Depositing this much and no more has to make the transfer possible.
    const missing = (r?.fix as { amount: bigint }).amount;
    expect(3_342_506n + missing).toBe(5n * M + 55_447n);
  });
});

describe('cctpShortfall', () => {
  const base = {
    maxFee: 100_000n,
    gasCost: 0n,
    nativeBalance: 0n,
    chainLabel: 'Base Sepolia',
    gasInUsdc: false,
  };

  it('passes with exactly enough', () => {
    expect(
      cctpShortfall({ ...base, usdcBalance: 5n * M, total: 5n * M, nativeBalance: 10n ** 16n }),
    ).toBeNull();
  });

  it('refuses when USDC does not cover amount plus fee', () => {
    const r = cctpShortfall({ ...base, usdcBalance: 4n * M, total: 5n * M });
    expect(r?.code).toBe('shortWithFee');
    expect(r?.params.amount).toBe('1');
    expect(r?.fix).toEqual({ kind: 'useMax', amount: 3_900_000n, display: '3.9' });
  });

  it('offers no Max when the fee alone exceeds the balance', () => {
    // "Use max" of a negative number is not an offer, it is a broken button.
    const r = cctpShortfall({ ...base, usdcBalance: 50_000n, total: 5n * M });
    expect(r?.code).toBe('shortWithFee');
    expect(r?.fix).toBeUndefined();
  });

  it('offers no Max when the balance is exactly the fee', () => {
    const r = cctpShortfall({ ...base, usdcBalance: 100_000n, total: 5n * M });
    expect(r?.fix).toBeUndefined();
  });

  it('refuses for gas when USDC is fine but the native balance is not', () => {
    const r = cctpShortfall({
      ...base,
      usdcBalance: 10n * M,
      total: 5n * M,
      gasCost: 10n ** 15n,
      nativeBalance: 10n ** 12n,
    });
    expect(r?.code).toBe('noGas');
    // Nothing this app can do about an empty gas tank, so nothing is offered.
    expect(r?.fix).toBeUndefined();
  });

  it('counts gas into the same balance where gas is USDC', () => {
    // Arc: the transfer fits, and then does not, because the gas comes out of the
    // same balance. A check that skipped this passes and the send reverts.
    const args = {
      ...base,
      gasInUsdc: true,
      usdcBalance: 5n * M,
      total: 5n * M,
      // 10^12 native subunits buy one USDC *subunit*, so a whole USDC of gas is
      // 10^18. Getting this wrong in the other direction is how a check under-counts
      // gas by a factor of a million and passes a wallet that cannot send.
      gasCost: 10n ** 18n,
      nativePerUsdc: 10n ** 12n,
    };
    const r = cctpShortfall(args);
    expect(r?.code).toBe('shortWithGas');
    expect(r?.params.amount).toBe('1');
    expect(r?.fix).toEqual({ kind: 'useMax', amount: 3_900_000n, display: '3.9' });
  });

  it('rounds gas up, never down', () => {
    // Half a subunit of gas still has to be paid for. Rounding it away is how a
    // check passes a wallet that is one subunit short.
    const r = cctpShortfall({
      ...base,
      gasInUsdc: true,
      usdcBalance: 5n * M,
      total: 5n * M,
      gasCost: 1n,
      nativePerUsdc: 10n ** 12n,
    });
    expect(r?.code).toBe('shortWithGas');
    expect(r?.params.amount).toBe('0.000001');
  });

  it('ignores the native balance where gas is USDC', () => {
    // Arc has no separate gas token; reading a zero native balance as "no gas"
    // would refuse every transfer on the home chain.
    expect(
      cctpShortfall({
        ...base,
        gasInUsdc: true,
        usdcBalance: 10n * M,
        total: 5n * M,
        gasCost: 10n ** 12n,
        nativeBalance: 0n,
        nativePerUsdc: 10n ** 12n,
      }),
    ).toBeNull();
  });
});

describe('percentOf', () => {
  it('takes a fraction of what can be sent', () => {
    expect(percentOf(10n * M, 0.25)).toBe('2.5');
    expect(percentOf(10n * M, 0.5)).toBe('5');
    expect(percentOf(10n * M, 1)).toBe('10');
  });

  it('returns nothing when there is nothing to send', () => {
    // An empty field is honest; "0" invites a press on a button that cannot work.
    expect(percentOf(0n, 0.5)).toBe('');
    expect(percentOf(-5n, 0.5)).toBe('');
  });

  it('truncates rather than rounding up', () => {
    // Rounding up produces a figure a hair above what is affordable, which is
    // refused for a fraction of a cent after the user pressed a button we offered.
    expect(percentOf(3n, 0.5)).toBe('0.000001');
    expect(percentOf(9_999_999n, 0.5)).toBe('4.999999');
  });

  it('gives back the whole spendable figure at 100%', () => {
    const spendable = 3_287_059n;
    expect(percentOf(spendable, 1)).toBe(usdc(spendable));
  });
});
