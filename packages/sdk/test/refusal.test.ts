import { describe, expect, it } from 'vitest';
import {
  allocate,
  cctpShortfall,
  gatewayShortfall,
  maxDeliverable,
  maxDepositable,
  percentOf,
  usdc,
  type SourceBalance,
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
  /**
   * Driven through `allocate` rather than fed hand-written figures.
   *
   * The refusal and the allocator have to agree, because the screen shows one and
   * the button obeys the other; a test that hands the refusal a shortfall the
   * allocator would never produce proves only that arithmetic works. So each case
   * below is a balance sheet, and the numbers that reach `gatewayShortfall` are
   * the ones the app would really pass it.
   *
   * Forwarding is fixed at Arc's measured 0.016 so the cases stay readable.
   */
  const FWD = 16_000n;
  const ask = (amount: bigint, balances: SourceBalance[]) => {
    const a = allocate({ amount, balances, forwarding: FWD });
    return gatewayShortfall({
      shortfall: a.shortfall,
      total: balances.reduce((s, b) => s + b.balance, 0n),
      amount,
      deliverable: maxDeliverable({ balances, forwarding: FWD }),
    });
  };

  it('says nothing when the split works', () => {
    // 5 out of 17.2 on one chain, comfortably.
    expect(ask(5n * M, [{ chain: 'Arc_Testnet', balance: 17_200_000n }])).toBeNull();
  });

  it('says nothing when the split works only by using two chains', () => {
    // Arc alone cannot pay 17.2 + 0.0035 + 0.016; with Base it can, and a screen
    // that refused this would be refusing a transfer that goes through.
    expect(
      ask(17_200_000n, [
        { chain: 'Arc_Testnet', balance: 17_202_570n },
        { chain: 'Base_Sepolia', balance: 12_890_000n },
      ]),
    ).toBeNull();
  });

  it('asks for a deposit when there is not enough anywhere', () => {
    const r = ask(10n * M, [
      { chain: 'Arc_Testnet', balance: 2n * M },
      { chain: 'Base_Sepolia', balance: 3n * M },
    ]);
    expect(r?.code).toBe('gwShort');
    expect(r?.fix?.kind).toBe('deposit');
  });

  it('asks for exactly what would make it possible', () => {
    // Depositing this much and no more has to clear the refusal. Anything less is
    // a second refusal after a second wait; anything more is money moved for
    // nothing.
    const balances: SourceBalance[] = [{ chain: 'Arc_Testnet', balance: 2n * M }];
    const r = ask(10n * M, balances);
    const missing = (r?.fix as { amount: bigint }).amount;
    const after = allocate({
      amount: 10n * M,
      balances: [{ chain: 'Arc_Testnet', balance: 2n * M + missing }],
      forwarding: FWD,
    });
    expect(after.shortfall).toBe(0n);
  });

  it('does not tell someone with enough money to deposit more', () => {
    /*
     * The case the old source-chain rule got wrong in the other direction. 20 USDC
     * spread over four chains, and a 20 USDC payment cannot go: four base fees and
     * one forwarding fee come out of the same 20. "Deposit 0.03" is technically a
     * fix and reads as an insult to someone looking at a 20 USDC balance, so the
     * offer is to send what fits instead.
     */
    const balances: SourceBalance[] = [
      { chain: 'Arc_Testnet', balance: 5n * M },
      { chain: 'Base_Sepolia', balance: 5n * M },
      { chain: 'OP_Sepolia', balance: 5n * M },
      { chain: 'Unichain_Sepolia', balance: 5n * M },
    ];
    const r = ask(20n * M, balances);
    expect(r?.code).toBe('gwStranded');
    expect(r?.fix?.kind).toBe('useMax');
    expect(r?.params.total).toBe('20');
  });

  it('offers a Max that actually goes through', () => {
    const balances: SourceBalance[] = [
      { chain: 'Arc_Testnet', balance: 5n * M },
      { chain: 'Base_Sepolia', balance: 5n * M },
      { chain: 'OP_Sepolia', balance: 5n * M },
      { chain: 'Unichain_Sepolia', balance: 5n * M },
    ];
    const offered = (ask(20n * M, balances)?.fix as { amount: bigint }).amount;
    expect(allocate({ amount: offered, balances, forwarding: FWD }).shortfall).toBe(0n);
    // And one subunit more must not, or the offer is leaving money unsendable.
    expect(allocate({ amount: offered + 1n, balances, forwarding: FWD }).shortfall).toBeGreaterThan(
      0n,
    );
  });

  it('asks for a deposit, not a smaller amount, when nothing can be delivered', () => {
    // Every chain is dust: there is no smaller amount to offer, so "send less" is
    // not a fix and the honest answer is that the money is not there.
    const r = ask(M, [
      { chain: 'Sei_Testnet', balance: 400n },
      { chain: 'Unichain_Sepolia', balance: 900n },
    ]);
    expect(r?.code).toBe('gwShort');
    expect(r?.fix?.kind).toBe('deposit');
  });

  it('refuses one subunit short', () => {
    /*
     * The boundary a check against the amount alone would let through: the balance
     * covers the transfer and not the fee, and Circle refuses after signing.
     *
     * 5 + the reserve. The reserve is the ceiling that gets signed, so the line
     * sits well above the 5.0195 that Circle actually charges: twice the gas part,
     * with the forwarding fee allowed to drift.
     *
     * One subunit under it the answer is `gwStranded` rather than `gwShort`, and
     * that is the right one: someone holding more than they are trying to send is
     * not short of money, and "deposit 0.000001 USDC" would be a fix nobody could
     * carry out. The offer is to send what fits.
     */
    // The quote plus the gas part again, with the forwarding fee allowed half as
    // much again to drift between being read and being signed.
    const gas = 3_500n + (FWD * 3n) / 2n;
    const reserve = gas + gas;
    expect(ask(5n * M, [{ chain: 'Arc_Testnet', balance: 5n * M + reserve - 1n }])?.code).toBe(
      'gwStranded',
    );
    expect(ask(5n * M, [{ chain: 'Arc_Testnet', balance: 5n * M + reserve }])).toBeNull();
  });

  it('calls it short, not stranded, when the balance is under the amount', () => {
    // One subunit the other side of the line that tells the two sentences apart.
    expect(ask(5n * M, [{ chain: 'Arc_Testnet', balance: 5n * M - 1n }])?.code).toBe('gwShort');
    expect(ask(5n * M, [{ chain: 'Arc_Testnet', balance: 5n * M }])?.code).toBe('gwStranded');
  });

  it('says nothing at zero, so a blank field is not an error', () => {
    expect(ask(0n, [])).toBeNull();
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
