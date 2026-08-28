import { describe, expect, it } from 'vitest';
import { GATEWAY_BASE_FEE, allocate, maxDeliverable, type GatewayChain } from '@ctrl-arcz/sdk';
import {
  capacityOf,
  pinsOf,
  planFor,
  rankCandidates,
  residualAfterAll,
  typedSubunits,
  type GatewaySource,
} from '../src/ui/sourceCards.js';

/**
 * The arithmetic behind the Gateway source rows.
 *
 * Every case here is one that reached the screen and looked fine. Adding a network
 * used to move money between per-chain amount fields, and getting that wrong did
 * not throw or blank: it silently changed what somebody was about to send. Both
 * directions happened, a 12 USDC payment that became 18 and an 11 USDC payment
 * that became 7.89, so the invariant those bugs violated is still asserted here
 * even though the mechanism that could break it is gone: the payment is one field
 * now, and adding a network must not touch it.
 */

const FWD = 16_000n; // forwarding into Arc, measured
const usdc = (n: string): bigint => {
  const [w = '0', f = ''] = n.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};

/** The balance sheet the cards are drawn against, and the room each chain has. */
const sheet: Record<string, bigint> = {
  Arc_Testnet: usdc('6'),
  Base_Sepolia: usdc('7'),
  OP_Sepolia: usdc('4'),
  Ethereum_Sepolia: usdc('500'),
};
const roomOn = (c: GatewayChain): bigint =>
  capacityOf({ chain: c, balance: sheet[c] ?? 0n }, FWD);

describe('typedSubunits', () => {
  it('reads a half-typed field as nothing rather than as an error', () => {
    // "1." is what an input holds between the 1 and the 5. It is not a mistake and
    // it is not 1: it is a number nobody has finished writing.
    expect(typedSubunits('1.')).toBe(1_000_000n);
    expect(typedSubunits('')).toBe(0n);
    expect(typedSubunits('.')).toBe(0n);
    expect(typedSubunits('abc')).toBe(0n);
    expect(typedSubunits('-5')).toBe(0n);
    expect(typedSubunits('0.000001')).toBe(1n);
  });
});

describe('capacityOf', () => {
  it('reports what a chain can pay, not whether it would be chosen', () => {
    /*
     * Ethereum costs a USDC a leg, so the allocator never picks it unasked. That
     * is a rule about choosing, and it was leaking into this: `maxDeliverable`
     * refuses costly chains by default, so a chain holding 500 USDC reported a
     * capacity of zero and the screen offered to top up rather than to use it.
     */
    const room = capacityOf({ chain: 'Ethereum_Sepolia', balance: usdc('500') }, FWD);
    // Nearly all of it: a leg there costs about a USDC, and the reserve doubles
    // that. What matters is that it is the balance less its fees rather than the
    // zero a "would we choose this chain" rule was returning.
    expect(room).toBeGreaterThan(usdc('497'));
    expect(room).toBeLessThan(usdc('500'));
  });

  it('holds back the fees, so what it reports can actually be sent', () => {
    const room = capacityOf({ chain: 'Arc_Testnet', balance: usdc('6') }, FWD);
    expect(room).toBeLessThan(usdc('6'));
    const a = allocate({
      amount: room,
      balances: [{ chain: 'Arc_Testnet', balance: usdc('6') }],
      forwarding: FWD,
    });
    expect(a.shortfall).toBe(0n);
  });

  it('is zero for a chain that cannot cover its own leg fee', () => {
    // Four hundredths against a leg that costs a tenth of a cent to open.
    expect(capacityOf({ chain: 'Sei_Testnet', balance: 400n }, FWD)).toBe(0n);
  });
});

describe('adding a network', () => {
  const balances = Object.entries(sheet).map(([c, balance]) => ({
    chain: c as GatewayChain,
    balance,
  }));
  const split = (amount: bigint, sources: GatewaySource[]) =>
    planFor({ amount, sources, balances, forwarding: FWD });

  it('never changes what is being sent', () => {
    /*
     * The contract, stated once. Adding a network is finding somewhere else for
     * part of a payment, not adding to it. The version this replaces did the
     * adding by hand across per-chain fields, and one branch of it turned 12 into
     * 18. Here the payment is an argument, so the only thing to assert is that the
     * legs deliver exactly it.
     */
    const one = split(usdc('12'), [{ chain: 'Arc_Testnet', amount: '' }]);
    expect(one.shortfall).toBeGreaterThan(0n); // Arc alone holds 6

    const two = split(usdc('12'), [
      { chain: 'Arc_Testnet', amount: '' },
      { chain: 'Base_Sepolia', amount: '' },
    ]);
    expect(two.shortfall).toBe(0n);
    expect(two.legs.reduce((sum, l) => sum + l.value, 0n)).toBe(usdc('12'));
  });

  it('loses nothing when one chain cannot take its share', () => {
    /*
     * The other direction, which was worse because it looked like it worked:
     * capping the old field to its ceiling dropped whatever the new chain could
     * not absorb, turning an 11 USDC payment into 7.89 with no warning. A split
     * either delivers the whole amount or reports a shortfall; there is no third
     * outcome where it quietly delivers less.
     */
    const a = split(usdc('11'), [
      { chain: 'Arc_Testnet', amount: '' },
      { chain: 'OP_Sepolia', amount: '' },
    ]);
    const delivered = a.legs.reduce((sum, l) => sum + l.value, 0n);
    expect(a.shortfall > 0n || delivered === usdc('11')).toBe(true);
  });

  it('converges: one more network at a time lands on a split that fits', () => {
    // The whole interaction, driven to a fixed point, with the payment held at
    // eleven throughout because nothing in the loop is allowed to touch it.
    const amount = usdc('11');
    let sources: GatewaySource[] = [{ chain: 'Arc_Testnet', amount: '' }];
    for (const chain of ['OP_Sepolia', 'Base_Sepolia'] as GatewayChain[]) {
      if (split(amount, sources).shortfall === 0n) break;
      sources = [...sources, { chain, amount: '' }];
    }
    const final = split(amount, sources);
    expect(final.shortfall).toBe(0n);
    expect(final.legs.reduce((sum, l) => sum + l.value, 0n)).toBe(amount);
  });

  it('uses a network that was added on purpose, even where one would have done', () => {
    // Adding Base to a payment Base could carry alone and watching Base contribute
    // nothing is the same broken promise as a checkbox that changes nothing.
    const a = split(usdc('3'), [
      { chain: 'Arc_Testnet', amount: '' },
      { chain: 'Base_Sepolia', amount: '' },
    ]);
    expect(a.shortfall).toBe(0n);
    expect(a.legs).toHaveLength(2);
    for (const leg of a.legs) expect(leg.value).toBeGreaterThan(0n);
  });

  it('takes a typed row literally and divides only the rest', () => {
    // The one thing the allocator is not allowed to be clever about: which balance
    // gets drained is the user's call, not arithmetic.
    const a = split(usdc('8'), [
      { chain: 'Arc_Testnet', amount: '2' },
      { chain: 'Base_Sepolia', amount: '' },
    ]);
    expect(a.shortfall).toBe(0n);
    expect(a.legs.find((l) => l.chain === 'Arc_Testnet')?.value).toBe(usdc('2'));
    // Base takes the remaining 6 rather than the 7 it holds: it leads, so it also
    // holds back the forwarding fee, and asking it for all 7 is how a split that
    // adds up gets refused by its own pre-flight check.
    expect(a.legs.find((l) => l.chain === 'Base_Sepolia')?.value).toBe(usdc('6'));
  });

  it('reports the excess rather than trimming it when typed rows overshoot', () => {
    // Typing 5 on two chains while sending 8 over-delivers by 2. Trimming would
    // undo a number somebody typed on purpose and delivering it would pay the
    // recipient more than was meant, so it is reported instead.
    const a = split(usdc('8'), [
      { chain: 'Arc_Testnet', amount: '5' },
      { chain: 'Base_Sepolia', amount: '5' },
    ]);
    expect(a.overfill).toBe(usdc('2'));
  });
});

describe('pinsOf', () => {
  it('passes on only the rows the user actually typed into', () => {
    // An empty row is "you decide", not "this chain pays zero". Passing it as a
    // pin of zero would be a pin the allocator has to filter out, and a row of
    // zero is a base fee paid to deliver nothing.
    expect(
      pinsOf([
        { chain: 'Arc_Testnet', amount: '2' },
        { chain: 'Base_Sepolia', amount: '' },
        { chain: 'OP_Sepolia', amount: '0' },
      ]),
    ).toEqual([{ chain: 'Arc_Testnet', value: usdc('2') }]);
  });
});

describe('the cost table the cards are drawn against', () => {
  it('is the SDK’s, not a copy', () => {
    // The component reads fees straight from the measured table. A second copy
    // here would be a second thing to update after the next measurement.
    expect(GATEWAY_BASE_FEE.Arc_Testnet).toBe(3_500n);
    expect(GATEWAY_BASE_FEE.Ethereum_Sepolia).toBe(1_000_000n);
  });
});

describe('residualAfterAll', () => {
  /**
   * The figure on the button that asks somebody to deposit, and the one rule it
   * has: never ask for money that is already there.
   *
   * The estimate this replaces broke that rule in both directions. It offered
   * "take the other 1.002768 from Base" while 3.31 was missing -- a step that
   * promises to finish and does not. And it priced every spare chain as though it
   * would lead the transfer, paying the whole forwarding fee, which is right for a
   * chain used alone and pessimistic by that reserve for a chain used second: on a
   * real balance sheet it asked for 1.478952 while the list beside it, which
   * simulates the split properly, said the same chain would leave 1.425302. Two
   * answers to one question, and the larger one on the button.
   *
   * So it is not estimated. Everything usable is added and the split is run.
   */
  const on = (chain: GatewayChain, amount: string) => ({ chain, balance: usdc(amount) });

  it('is zero while the money is merely on chains the payment has not been pointed at', () => {
    // Nothing to deposit: Base is right there, it just has not been added yet.
    expect(
      residualAfterAll({
        amount: usdc('10'),
        sources: [{ chain: 'Arc_Testnet', amount: '' }],
        balances: [on('Arc_Testnet', '3'), on('Base_Sepolia', '13')],
        forwarding: FWD,
      }),
    ).toBe(0n);
  });

  it('adds up every chain left before asking for anything', () => {
    // No single chain covers 3, but the three together do, so nothing is missing.
    expect(
      residualAfterAll({
        amount: usdc('3'),
        sources: [{ chain: 'Arc_Testnet', amount: '' }],
        balances: [
          on('Arc_Testnet', '0.2'),
          on('Base_Sepolia', '1.3'),
          on('OP_Sepolia', '1.2'),
          on('Sonic_Testnet', '1.1'),
        ],
        forwarding: FWD,
      }),
    ).toBe(0n);
  });

  it('asks only for what is genuinely still missing', () => {
    /*
     * Everything is used and it is still not enough. The figure is the gap that
     * remains, not the gap before the other chains were counted -- the raw
     * shortfall would ask for money the wallet already has.
     */
    const r = residualAfterAll({
      amount: usdc('10'),
      sources: [{ chain: 'Arc_Testnet', amount: '' }],
      balances: [on('Arc_Testnet', '2'), on('Base_Sepolia', '3')],
      forwarding: FWD,
    });
    expect(r).toBeGreaterThan(0n);
    // Five of the ten are on the books, so what is missing is about five, not ten.
    expect(r).toBeLessThan(usdc('5.2'));
    expect(r).toBeGreaterThan(usdc('5'));
  });

  it('does not count a chain that cannot cover its own leg fee', () => {
    // Four hundredths on Sei is not four hundredths towards the payment.
    const withDust = residualAfterAll({
      amount: usdc('10'),
      sources: [{ chain: 'Arc_Testnet', amount: '' }],
      balances: [on('Arc_Testnet', '2'), on('Sei_Testnet', '0.0004')],
      forwarding: FWD,
    });
    const without = residualAfterAll({
      amount: usdc('10'),
      sources: [{ chain: 'Arc_Testnet', amount: '' }],
      balances: [on('Arc_Testnet', '2')],
      forwarding: FWD,
    });
    expect(withDust).toBe(without);
  });

  it('uses a costly chain rather than asking for a deposit that is not needed', () => {
    /*
     * Ethereum costs about a USDC a leg, which is why the allocator never reaches
     * for it unasked. That is a rule about which split to choose; it is not a
     * reason to tell somebody holding 500 USDC there that they have to deposit.
     */
    expect(
      residualAfterAll({
        amount: usdc('100'),
        sources: [{ chain: 'Arc_Testnet', amount: '' }],
        balances: [on('Arc_Testnet', '1'), on('Ethereum_Sepolia', '500')],
        forwarding: FWD,
      }),
    ).toBe(0n);
  });

  it('keeps a typed row, because a deposit for a payment nobody asked for is wrong', () => {
    // Arc pinned to 1 of a 10 payment: what is missing is judged against the
    // payment as the user has actually set it up, not against a tidier one.
    const r = residualAfterAll({
      amount: usdc('10'),
      sources: [{ chain: 'Arc_Testnet', amount: '1' }],
      balances: [on('Arc_Testnet', '9'), on('Base_Sepolia', '2')],
      forwarding: FWD,
    });
    expect(r).toBeGreaterThan(usdc('6.9'));
    expect(r).toBeLessThan(usdc('7.1'));
  });

  it('asks for nothing when nothing is being sent', () => {
    expect(
      residualAfterAll({ amount: 0n, sources: [], balances: [], forwarding: FWD }),
    ).toBe(0n);
  });
});

describe('what actually arrives', () => {
  /**
   * The figure the To card shows, which is the largest number on the screen and
   * therefore the worst one to get wrong.
   *
   * The first attempt subtracted the allocator's shortfall from the typed total,
   * and it went NEGATIVE: asking a chain holding 0.031426 for 7 reports a
   * shortfall of 7.022626, because the fees that could not be covered are counted
   * in it too. "You receive -0.022626" was on screen.
   *
   * `maxDeliverable` over the listed chains is the honest answer, and it is the
   * same function the Max button uses, so the two cannot disagree.
   */
  const deliverable = (typedTotal: bigint, balances: { chain: GatewayChain; balance: bigint }[]) => {
    const listed = new Set(balances.map((b) => b.chain));
    const reach = maxDeliverable({ balances, forwarding: FWD, allow: (c) => listed.has(c) });
    return reach < typedTotal ? reach : typedTotal;
  };

  it('is never negative, however hopeless the ask', () => {
    const out = deliverable(usdc('7'), [{ chain: 'Arc_Testnet', balance: 31_426n }]);
    expect(out).toBeGreaterThanOrEqual(0n);
    expect(out).toBe(0n);
  });

  it('is what was asked for when it can all be sent', () => {
    expect(deliverable(usdc('2'), [{ chain: 'Arc_Testnet', balance: usdc('6') }])).toBe(usdc('2'));
  });

  it('is what the chains can manage when it cannot', () => {
    const balances = [
      { chain: 'Arc_Testnet' as GatewayChain, balance: usdc('3.687096') },
      { chain: 'Base_Sepolia' as GatewayChain, balance: usdc('1.070252') },
    ];
    const out = deliverable(usdc('123'), balances);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(usdc('4.76'));
    // And it is sendable, which is the whole claim being made by showing it.
    expect(allocate({ amount: out, balances, forwarding: FWD }).shortfall).toBe(0n);
  });
});

describe('rankCandidates', () => {
  const on = (chain: GatewayChain, amount: string) => ({ chain, balance: usdc(amount) });

  it('ranks by what the whole plan would cost, not by the chain’s own fee', () => {
    /*
     * The case that motivated this, in the user's words: sending 7 with 6 on Arc,
     * 0.5 on Base and 1.1 on OP. Base charges 0.01 a leg and OP 0.0015, but that
     * is not what decides it -- Base is too small to finish the payment and OP is
     * not, so OP is the answer and Base is not an answer at all.
     */
    const ranked = rankCandidates({
      amount: usdc('7'),
      sources: [{ chain: 'Arc_Testnet', amount: '' }],
      balances: [on('Arc_Testnet', '6'), on('Base_Sepolia', '0.5'), on('OP_Sepolia', '1.1')],
      forwarding: FWD,
    });
    expect(ranked[0]?.chain).toBe('OP_Sepolia');
    expect(ranked[0]?.completes).toBe(true);
    expect(ranked[0]?.tone).toBe('best');
    // Base is still listed, because it is a real place their money is. It just
    // says what it would leave behind instead of a price.
    const base = ranked.find((r) => r.chain === 'Base_Sepolia');
    expect(base?.completes).toBe(false);
    expect(base?.stillShort).toBeGreaterThan(0n);
  });

  it('prefers finishing the payment over a cheaper leg that does not', () => {
    // Unichain is the cheapest chain there is (0.001) and holds nothing useful;
    // Base costs ten times that and can carry the rest. Cheapness does not win.
    const ranked = rankCandidates({
      amount: usdc('9'),
      sources: [{ chain: 'Arc_Testnet', amount: '' }],
      balances: [on('Arc_Testnet', '5'), on('Unichain_Sepolia', '0.2'), on('Base_Sepolia', '6')],
      forwarding: FWD,
    });
    expect(ranked[0]?.chain).toBe('Base_Sepolia');
    expect(ranked[0]?.completes).toBe(true);
  });

  it('puts a chain that costs a whole USDC last, and says so', () => {
    // Ethereum finishes the payment and costs a thousand times the alternative.
    // It is offered -- 500 USDC sitting there is not nothing -- and flagged.
    const ranked = rankCandidates({
      amount: usdc('9'),
      sources: [{ chain: 'Arc_Testnet', amount: '' }],
      balances: [on('Arc_Testnet', '5'), on('Base_Sepolia', '6'), on('Ethereum_Sepolia', '500')],
      forwarding: FWD,
    });
    const eth = ranked.find((r) => r.chain === 'Ethereum_Sepolia');
    expect(eth?.completes).toBe(true);
    expect(eth?.tone).toBe('costly');
    expect(ranked[ranked.length - 1]?.chain).toBe('Ethereum_Sepolia');
  });

  it('reports a dust chain as unusable rather than leaving it out', () => {
    /*
     * The failure the user hit: 0.078985 spread on a chain that cannot cover its
     * own leg fee. The old control returned no offer at all, so the add button
     * disappeared and the screen said only "top up" -- with no way to find out
     * whether there was anything on the other chains or not. It is listed now,
     * with a zero room, and the picker greys it out with the reason.
     */
    const ranked = rankCandidates({
      amount: usdc('6.1'),
      sources: [{ chain: 'Arc_Testnet', amount: '' }],
      balances: [on('Arc_Testnet', '6.031096'), on('Sei_Testnet', '0.0004')],
      forwarding: FWD,
    });
    const sei = ranked.find((r) => r.chain === 'Sei_Testnet');
    expect(sei).toBeDefined();
    expect(sei?.room).toBe(0n);
    expect(sei?.completes).toBe(false);
  });

  it('never offers a chain already carrying part of the payment', () => {
    const ranked = rankCandidates({
      amount: usdc('9'),
      sources: [
        { chain: 'Arc_Testnet', amount: '' },
        { chain: 'Base_Sepolia', amount: '' },
      ],
      balances: [on('Arc_Testnet', '5'), on('Base_Sepolia', '6'), on('OP_Sepolia', '4')],
      forwarding: FWD,
    });
    expect(ranked.map((r) => r.chain)).toEqual(['OP_Sepolia']);
  });

  it('orders by balance when there is no amount to price against', () => {
    // Nothing typed yet, so no plan to compare: the useful order is where the
    // money is.
    const ranked = rankCandidates({
      amount: 0n,
      sources: [{ chain: 'Arc_Testnet', amount: '' }],
      balances: [on('Arc_Testnet', '5'), on('Base_Sepolia', '2'), on('OP_Sepolia', '9')],
      forwarding: FWD,
    });
    expect(ranked.map((r) => r.chain)).toEqual(['OP_Sepolia', 'Base_Sepolia']);
  });

  it('is empty when every chain is already in use', () => {
    expect(
      rankCandidates({
        amount: usdc('9'),
        sources: [{ chain: 'Arc_Testnet', amount: '' }],
        balances: [on('Arc_Testnet', '5')],
        forwarding: FWD,
      }),
    ).toEqual([]);
  });
});
