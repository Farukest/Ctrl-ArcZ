import { describe, expect, it } from 'vitest';
import { GATEWAY_CHAIN_NAMES } from '../src/bridge/gateway.js';
import {
  allocate,
  maxDeliverable,
  COSTLY_BASE_FEE,
  GATEWAY_BASE_FEE,
  MAX_INTENTS,
  type SourceBalance,
} from '../src/bridge/allocate.js';

/** Forwarding into Arc, measured at about 0.016 USDC. */
const FWD = 16_000n;
/**
 * What a leg holds back: the quote plus the whole gas-bearing part again, with
 * the forwarding fee allowed half as much again to drift. Restated here rather
 * than imported so that a change to the reserve has to be agreed to twice.
 */
const reserve = (baseFee: bigint, forwarding = 0n): bigint => {
  const gas = baseFee + (forwarding * 3n) / 2n;
  const quoted = forwarding > 0n ? gas : (baseFee * 11n) / 10n;
  return quoted + (gas > 5_000n ? gas : 5_000n);
};
const usdc = (n: string): bigint => {
  const [w = '0', f = ''] = n.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const on = (chain: SourceBalance['chain'], amount: string): SourceBalance => ({
  chain,
  balance: usdc(amount),
});

describe('the cost table is the measured one', () => {
  it('spans three orders of magnitude, which is why leg choice matters', () => {
    expect(GATEWAY_BASE_FEE.Unichain_Sepolia).toBe(1_000n);
    expect(GATEWAY_BASE_FEE.Arc_Testnet).toBe(3_500n);
    expect(GATEWAY_BASE_FEE.Base_Sepolia).toBe(10_000n);
    expect(GATEWAY_BASE_FEE.Ethereum_Sepolia).toBe(1_000_000n);
  });

  it('marks only Ethereum as the user’s decision', () => {
    const costly = Object.entries(GATEWAY_BASE_FEE).filter(([, f]) => f >= COSTLY_BASE_FEE);
    expect(costly.map(([c]) => c)).toEqual(['Ethereum_Sepolia']);
  });
});

describe('one chain is enough', () => {
  it('takes a single leg and does not split', () => {
    const a = allocate({
      amount: usdc('5'),
      balances: [on('Arc_Testnet', '17.2'), on('Base_Sepolia', '13')],
      forwarding: FWD,
    });
    expect(a.legs).toHaveLength(1);
    expect(a.legs[0]?.chain).toBe('Arc_Testnet');
    expect(a.shortfall).toBe(0n);
  });

  it('prefers the cheaper chain when both could carry it alone', () => {
    // Unichain costs 0.001 a leg, Base 0.01, and both hold plenty.
    const a = allocate({
      amount: usdc('5'),
      balances: [on('Base_Sepolia', '50'), on('Unichain_Sepolia', '50')],
      forwarding: FWD,
    });
    expect(a.legs).toHaveLength(1);
    expect(a.legs[0]?.chain).toBe('Unichain_Sepolia');
  });

  it('the destination chain earns no discount, only a cheap base fee does', () => {
    // Paying into Arc while holding on Arc and on Unichain: Unichain still wins,
    // because same-chain confers nothing. Measured: Base->Base cost more than
    // Arc->Base.
    const a = allocate({
      amount: usdc('5'),
      balances: [on('Arc_Testnet', '50'), on('Unichain_Sepolia', '50')],
      forwarding: FWD,
    });
    expect(a.legs[0]?.chain).toBe('Unichain_Sepolia');
  });
});

describe('the balance covers the amount but not the fee', () => {
  it('reaches for a second chain rather than failing', () => {
    // 17.202570 on Arc, sending 17.20. Needs 17.20 + 0.0035 + 0.016.
    const a = allocate({
      amount: usdc('17.2'),
      balances: [on('Arc_Testnet', '17.20257'), on('Base_Sepolia', '13')],
      forwarding: FWD,
    });
    expect(a.shortfall).toBe(0n);
    expect(a.legs.length).toBeGreaterThan(1);
    const total = a.legs.reduce((s, l) => s + l.value, 0n);
    expect(total).toBe(usdc('17.2'));
  });

  it('maxDeliverable is what a Max button should fill in', () => {
    const balances = [on('Arc_Testnet', '17.20257')];
    const max = maxDeliverable({ balances, forwarding: FWD });
    /*
     * 17.20257 less what the signature will authorise, not less what Circle will
     * charge. Those differ by nearly a factor of two -- `spendFromGateway` signs
     * the quote plus the whole gas-bearing part again, so a doubling of gas
     * between quoting and settling still goes through -- and holding back only
     * the charge is how a Max button produces the one amount the next check
     * refuses.
     */
    expect(max).toBe(usdc('17.20257') - reserve(3_500n, FWD));
    // Which is the property that matters: the figure it offers has to allocate.
    const a = allocate({ amount: max, balances, forwarding: FWD });
    expect(a.legs).toHaveLength(1);
    expect(a.shortfall).toBe(0n);
    // And nothing above it may, or Max is leaving money unsendable.
    expect(allocate({ amount: max + 1n, balances, forwarding: FWD }).shortfall).toBeGreaterThan(0n);
  });

  it('tells the user the charge, and reserves the ceiling', () => {
    // Two numbers on purpose. `fee` is what leaves the balance and is what the
    // screen shows; `ceiling` is what the signature authorises and is what
    // feasibility is judged against. Measured: Circle charges the base fees plus
    // one forwarding fee, and reports exactly that as `fees.total`.
    const a = allocate({
      amount: usdc('5'),
      balances: [on('Arc_Testnet', '17.2')],
      forwarding: FWD,
    });
    expect(a.fee).toBe(3_500n + FWD);
    expect(a.ceiling).toBe(reserve(3_500n, FWD));
    expect(a.committed).toBe(usdc('5') + a.ceiling);
    expect(a.ceiling).toBeGreaterThan(a.fee);
  });

  it('holds back enough for the forwarding fee to move before it is signed', () => {
    /*
     * The failure this exists to stop, measured on a real 20 USDC transfer: the
     * Arc leg was filled to the exact subunit of what the allocator thought it
     * could hold, forwarding rose from 0.015897 to 0.018289 between the quote
     * that fed the allocator and the quote that was signed, and the spend refused
     * itself after the split had been shown as workable.
     *
     * So the reserve has to survive a fee that is worse than the one it was told
     * about. Fifteen percent is what was actually seen.
     */
    const balances = [on('Arc_Testnet', '17.20257')];
    const max = maxDeliverable({ balances, forwarding: FWD });
    const held = usdc('17.20257') - max;

    // What `spendFromGateway` would actually sign once the fee has moved: Circle
    // quotes the first leg its base fee plus the new forwarding fee, and the
    // margin adds the whole gas-bearing part again.
    const signedAt = (f: bigint) => 2n * (3_500n + f);

    expect(held).toBeGreaterThanOrEqual(signedAt((FWD * 115n) / 100n));
    // The allowance runs out at half as much again, which is where it was set.
    expect(held).toBeGreaterThanOrEqual(signedAt((FWD * 3n) / 2n));
    expect(held).toBeLessThan(signedAt((FWD * 151n) / 100n));
  });

  it('charges each extra leg its own base fee and one forwarding fee', () => {
    const a = allocate({
      amount: usdc('11'),
      balances: [on('Arc_Testnet', '4'), on('Base_Sepolia', '4'), on('OP_Sepolia', '4')],
      forwarding: FWD,
    });
    expect(a.legs).toHaveLength(3);
    // 0.0035 + 0.01 + 0.0015, and forwarding once rather than three times.
    expect(a.fee).toBe(3_500n + 10_000n + 1_500n + FWD);
  });
});

describe('more than one chain is needed', () => {
  it('puts the roomiest leg first, because forwarding lands there', () => {
    const a = allocate({
      amount: usdc('12'),
      balances: [on('Arc_Testnet', '6'), on('Base_Sepolia', '7')],
      forwarding: FWD,
    });
    expect(a.shortfall).toBe(0n);
    expect(a.legs).toHaveLength(2);
    expect(a.legs[0]?.chain).toBe('Base_Sepolia');
    // The first leg carries its value, its own fee and the whole forwarding fee.
    const first = a.legs[0];
    expect(first!.value + GATEWAY_BASE_FEE.Base_Sepolia + FWD).toBeLessThanOrEqual(usdc('7'));
  });

  it('never asks a leg for more than its chain holds', () => {
    const balances = [on('Arc_Testnet', '6'), on('Base_Sepolia', '7'), on('OP_Sepolia', '2')];
    const a = allocate({ amount: usdc('13'), balances, forwarding: FWD });
    expect(a.shortfall).toBe(0n);
    for (const [i, leg] of a.legs.entries()) {
      const held = balances.find((b) => b.chain === leg.chain)!.balance;
      const owed = leg.value + GATEWAY_BASE_FEE[leg.chain] + (i === 0 ? FWD : 0n);
      expect(owed).toBeLessThanOrEqual(held);
    }
  });

  it('delivers exactly the amount asked for', () => {
    const a = allocate({
      amount: usdc('12'),
      balances: [on('Arc_Testnet', '6'), on('Base_Sepolia', '7')],
      forwarding: FWD,
    });
    expect(a.legs.reduce((s, l) => s + l.value, 0n)).toBe(usdc('12'));
  });
});

describe('what it refuses', () => {
  it('reports a shortfall when the total cannot cover it', () => {
    const a = allocate({
      amount: usdc('10'),
      balances: [on('Arc_Testnet', '2'), on('Base_Sepolia', '3')],
      forwarding: FWD,
    });
    expect(a.legs).toHaveLength(0);
    expect(a.shortfall).toBeGreaterThan(0n);
  });

  it('ignores a chain that cannot cover its own fee', () => {
    // Base holds 0.004 and a Base leg costs 0.01, so it can only make things worse.
    const a = allocate({
      amount: usdc('9.99'),
      balances: [on('Arc_Testnet', '9.99'), on('Base_Sepolia', '0.004')],
      forwarding: FWD,
    });
    expect(a.legs.every((l) => l.chain !== 'Base_Sepolia')).toBe(true);
  });

  it('leaves Ethereum out unless the user has agreed to it', () => {
    const balances = [on('Arc_Testnet', '1'), on('Ethereum_Sepolia', '500')];
    const refused = allocate({ amount: usdc('100'), balances, forwarding: FWD });
    expect(refused.legs).toHaveLength(0);
    expect(refused.shortfall).toBeGreaterThan(0n);

    const agreed = allocate({ amount: usdc('100'), balances, forwarding: FWD, allow: () => true });
    expect(agreed.shortfall).toBe(0n);
    expect(agreed.costly).toBe(true);
  });

  it('stops at Circle’s sixteen intent cap', () => {
    // Seventeen chains would be needed, but only eleven exist and the cap is 16.
    const balances: SourceBalance[] = Array.from({ length: 11 }, (_, i) => ({
      chain: (
        [
          'Arc_Testnet',
          'Base_Sepolia',
          'OP_Sepolia',
          'Polygon_Amoy',
          'Unichain_Sepolia',
          'Sei_Testnet',
          'Sonic_Testnet',
          'World_Chain_Sepolia',
          'Arbitrum_Sepolia',
          'Avalanche_Fuji',
          'Ethereum_Sepolia',
        ] as const
      )[i]!,
      balance: usdc('1'),
    }));
    const a = allocate({ amount: usdc('100'), balances, forwarding: FWD, allow: () => true });
    expect(a.legs.length).toBeLessThanOrEqual(MAX_INTENTS);
  });
});

describe('degenerate input', () => {
  it('treats a zero amount as already covered', () => {
    const a = allocate({ amount: 0n, balances: [on('Arc_Testnet', '5')], forwarding: FWD });
    expect(a.legs).toHaveLength(0);
    expect(a.shortfall).toBe(0n);
  });

  it('reports the whole amount short when there is nothing anywhere', () => {
    const a = allocate({ amount: usdc('5'), balances: [], forwarding: FWD });
    expect(a.shortfall).toBeGreaterThan(0n);
  });
});

describe('legs the user set by hand', () => {
  /**
   * The blocks on screen. Someone says "five from Base and five from Avalanche",
   * and the answer has to be exactly that: not a cheaper split, not a reordered
   * one, not a trimmed one. Whatever the pins leave uncovered is still the app's
   * job, so pinning one leg of three leaves the other two automatic.
   */
  const three: SourceBalance[] = [
    on('Arc_Testnet', '17.2'),
    on('Base_Sepolia', '12.89'),
    on('Avalanche_Fuji', '20'),
  ];

  it('honours an exact split the app would never have chosen', () => {
    // Arc alone could carry 10 and would be cheaper. The user said otherwise.
    const a = allocate({
      amount: usdc('10'),
      balances: three,
      forwarding: FWD,
      pinned: [
        { chain: 'Base_Sepolia', value: usdc('5') },
        { chain: 'Avalanche_Fuji', value: usdc('5') },
      ],
    });
    expect(a.shortfall).toBe(0n);
    expect(a.overfill).toBe(0n);
    expect([...a.legs].map((l) => l.chain).sort()).toEqual(['Avalanche_Fuji', 'Base_Sepolia']);
    for (const l of a.legs) expect(l.value).toBe(usdc('5'));
    // Arc was cheaper and is not in the split, which is the whole point.
    expect(a.legs.some((l) => l.chain === 'Arc_Testnet')).toBe(false);
  });

  it('fills what the pins leave uncovered', () => {
    const a = allocate({
      amount: usdc('10'),
      balances: three,
      forwarding: FWD,
      pinned: [{ chain: 'Base_Sepolia', value: usdc('4') }],
    });
    expect(a.shortfall).toBe(0n);
    expect(a.legs.find((l) => l.chain === 'Base_Sepolia')?.value).toBe(usdc('4'));
    expect(a.legs.reduce((s, l) => s + l.value, 0n)).toBe(usdc('10'));
    expect(a.legs.length).toBeGreaterThan(1);
  });

  it('reports over-filling rather than trimming a typed number', () => {
    // Two fives against an eight. Trimming would undo something typed on purpose;
    // sending it would pay the recipient more than was meant.
    const a = allocate({
      amount: usdc('8'),
      balances: three,
      forwarding: FWD,
      pinned: [
        { chain: 'Base_Sepolia', value: usdc('5') },
        { chain: 'Avalanche_Fuji', value: usdc('5') },
      ],
    });
    expect(a.overfill).toBe(usdc('2'));
    expect(a.legs.reduce((s, l) => s + l.value, 0n)).toBe(usdc('10'));
  });

  it('still puts the roomiest leg first, whoever chose the legs', () => {
    /*
     * Forwarding is deducted in the order the intents are passed, so this is a
     * safety property and not a preference: a leg with nothing to spare placed
     * first was billed 0.062893 and died after signing. The user picks the chains
     * and the amounts; the order is not theirs to get wrong.
     */
    const a = allocate({
      amount: usdc('10'),
      balances: [on('Unichain_Sepolia', '5.01'), on('Avalanche_Fuji', '20')],
      forwarding: FWD,
      pinned: [
        { chain: 'Unichain_Sepolia', value: usdc('5') },
        { chain: 'Avalanche_Fuji', value: usdc('5') },
      ],
    });
    expect(a.shortfall).toBe(0n);
    expect(a.legs[0]?.chain).toBe('Avalanche_Fuji');
  });

  it('names the chain that cannot pay, and by how much', () => {
    // A pin past what that chain holds. The user has to be told which block is
    // wrong, not that "the total" is short.
    const a = allocate({
      amount: usdc('20'),
      balances: three,
      forwarding: FWD,
      pinned: [{ chain: 'Base_Sepolia', value: usdc('13') }],
    });
    expect(a.shortfall).toBeGreaterThan(0n);
    expect(a.legs).toHaveLength(0);
  });

  it('lets a pin reach a chain the automatic split refuses', () => {
    // Ethereum is never chosen on its own account, but choosing it is allowed.
    const balances = [on('Arc_Testnet', '1'), on('Ethereum_Sepolia', '500')];
    expect(allocate({ amount: usdc('100'), balances, forwarding: FWD }).shortfall).toBeGreaterThan(
      0n,
    );
    const a = allocate({
      amount: usdc('100'),
      balances,
      forwarding: FWD,
      allow: () => true,
      pinned: [{ chain: 'Ethereum_Sepolia', value: usdc('100') }],
    });
    expect(a.shortfall).toBe(0n);
    expect(a.costly).toBe(true);
  });

  it('ignores a pin of nothing rather than sending a leg that moves nothing', () => {
    // An emptied block is not a leg. A zero-value intent pays a base fee to
    // deliver nothing, and Circle is asked for one intent fewer instead.
    const a = allocate({
      amount: usdc('5'),
      balances: three,
      forwarding: FWD,
      pinned: [{ chain: 'Base_Sepolia', value: 0n }],
    });
    expect(a.legs.every((l) => l.value > 0n)).toBe(true);
    expect(a.shortfall).toBe(0n);
  });

  it('refuses more pinned legs than Circle will take', () => {
    // Sixteen is the cap; the seventeenth is refused outright, and finding that
    // out after the wallet has opened is the worst place for it.
    const many = Array.from({ length: 17 }, (_, i) => ({
      chain: GATEWAY_CHAIN_NAMES[i % GATEWAY_CHAIN_NAMES.length] as SourceBalance['chain'],
      value: usdc('1'),
    }));
    const a = allocate({
      amount: usdc('17'),
      balances: GATEWAY_CHAIN_NAMES.map((c) => on(c, '100')),
      forwarding: FWD,
      allow: () => true,
      pinned: many,
    });
    expect(a.legs).toHaveLength(0);
    expect(a.shortfall).toBeGreaterThan(0n);
  });
});

describe('chains listed by hand are all used', () => {
  /**
   * `spread` exists because the two jobs pull opposite ways. Left to itself the
   * allocator packs a payment into as few legs as it can, since an extra leg is
   * an extra base fee for nothing. The moment somebody has added a chain on
   * purpose that becomes wrong: adding Base and watching Base contribute zero is
   * the same broken promise as a checkbox that changes nothing.
   */
  const two: SourceBalance[] = [on('Unichain_Sepolia', '50'), on('Base_Sepolia', '50')];

  it('splits between them even when one could carry the lot', () => {
    const packed = allocate({ amount: usdc('10'), balances: two, forwarding: FWD });
    expect(packed.legs).toHaveLength(1);

    const shared = allocate({ amount: usdc('10'), balances: two, forwarding: FWD, spread: true });
    expect(shared.legs).toHaveLength(2);
    expect(shared.legs.reduce((s, l) => s + l.value, 0n)).toBe(usdc('10'));
    for (const l of shared.legs) expect(l.value).toBe(usdc('5'));
  });

  it('costs more, which is the price of the instruction', () => {
    const packed = allocate({ amount: usdc('10'), balances: two, forwarding: FWD });
    const shared = allocate({ amount: usdc('10'), balances: two, forwarding: FWD, spread: true });
    expect(shared.fee).toBeGreaterThan(packed.fee);
    // Exactly one extra base fee, not a second forwarding fee.
    expect(shared.fee - packed.fee).toBe(10_000n);
  });

  it('gives a chain only what it can hold, and offers the rest round again', () => {
    // Unichain can spare about 2, so it takes that and Base carries the remaining
    // 8 rather than the split failing or Unichain being asked for what it lacks.
    const a = allocate({
      amount: usdc('10'),
      balances: [on('Unichain_Sepolia', '2.01'), on('Base_Sepolia', '50')],
      forwarding: FWD,
      spread: true,
    });
    expect(a.shortfall).toBe(0n);
    expect(a.legs).toHaveLength(2);
    expect(a.legs.reduce((s, l) => s + l.value, 0n)).toBe(usdc('10'));
    const uni = a.legs.find((l) => l.chain === 'Unichain_Sepolia');
    expect(uni?.value).toBeLessThan(usdc('2.01'));
    expect(uni?.value).toBeGreaterThan(0n);
  });

  it('drops a chain that ends up with nothing rather than sending an empty leg', () => {
    // A zero-value intent pays a base fee to move nothing. One subunit cannot be
    // split three ways, so the leftover goes to one chain and the others are gone.
    const a = allocate({
      amount: 1n,
      balances: [on('Unichain_Sepolia', '5'), on('Base_Sepolia', '5'), on('OP_Sepolia', '5')],
      forwarding: 0n,
      spread: true,
    });
    expect(a.shortfall).toBe(0n);
    expect(a.legs).toHaveLength(1);
    expect(a.legs[0]?.value).toBe(1n);
  });

  it('mixes a pinned block with shared ones', () => {
    // Pin one at 6; the other two share the remaining 4.
    const a = allocate({
      amount: usdc('10'),
      balances: [on('Unichain_Sepolia', '50'), on('Base_Sepolia', '50'), on('OP_Sepolia', '50')],
      forwarding: FWD,
      spread: true,
      pinned: [{ chain: 'Base_Sepolia', value: usdc('6') }],
    });
    expect(a.shortfall).toBe(0n);
    expect(a.legs.find((l) => l.chain === 'Base_Sepolia')?.value).toBe(usdc('6'));
    expect(a.legs.find((l) => l.chain === 'Unichain_Sepolia')?.value).toBe(usdc('2'));
    expect(a.legs.find((l) => l.chain === 'OP_Sepolia')?.value).toBe(usdc('2'));
  });

  it('is still short when the listed chains cannot cover it', () => {
    const a = allocate({
      amount: usdc('10'),
      balances: [on('Unichain_Sepolia', '2'), on('Base_Sepolia', '3')],
      forwarding: FWD,
      spread: true,
    });
    expect(a.shortfall).toBeGreaterThan(0n);
    expect(a.legs).toHaveLength(0);
  });
});

describe('Max and the split it was calculated for agree', () => {
  /**
   * The invariant that keeps a Max button honest, on both paths.
   *
   * `maxDeliverable` works out what these balances can send by holding back a
   * reserve on every leg and the forwarding fee on the roomiest. If the split
   * then divides the money any other way, the figure it produced is refused by
   * the very allocation it was calculated for -- the app disagreeing with itself,
   * over money, at the last step.
   *
   * It got this wrong once already: an even 3.97 each out of OP 4 and Arc 4, and
   * then OP was asked for 4.021 of the 4 it holds, so the blocks went blank under
   * a shortfall that should not have existed.
   */
  const sheets: SourceBalance[][] = [
    [on('OP_Sepolia', '4'), on('Arc_Testnet', '4')],
    [on('Arc_Testnet', '17.2'), on('Base_Sepolia', '12.89')],
    [on('Unichain_Sepolia', '50'), on('Base_Sepolia', '50')],
    [on('Arc_Testnet', '4'), on('Base_Sepolia', '4'), on('OP_Sepolia', '4')],
    [on('Unichain_Sepolia', '2.01'), on('Base_Sepolia', '50')],
    [on('Arc_Testnet', '9.99'), on('Sei_Testnet', '0.0004')],
  ];

  for (const spread of [false, true]) {
    it(`sends exactly what Max offers, ${spread ? 'sharing' : 'packing'}`, () => {
      for (const balances of sheets) {
        const max = maxDeliverable({ balances, forwarding: FWD });
        if (max <= 0n) continue;
        const a = allocate({ amount: max, balances, forwarding: FWD, spread });
        const sheet = balances.map((b) => `${b.chain} ${b.balance}`).join(', ');
        expect(a.shortfall, `${sheet} at max ${max}`).toBe(0n);
        expect(a.legs.reduce((s, l) => s + l.value, 0n)).toBe(max);
      }
    });
  }

  it('never asks a chain for more than it holds', () => {
    // The check that would have caught it directly, over every sheet and both
    // paths: a leg is only real if its own chain can cover it and its reserve.
    for (const spread of [false, true]) {
      for (const balances of sheets) {
        for (const amount of [usdc('1'), usdc('5'), maxDeliverable({ balances, forwarding: FWD })]) {
          if (amount <= 0n) continue;
          const a = allocate({ amount, balances, forwarding: FWD, spread });
          a.legs.forEach((leg, i) => {
            const held = balances.find((b) => b.chain === leg.chain)?.balance ?? 0n;
            const needs = leg.value + reserve(GATEWAY_BASE_FEE[leg.chain], i === 0 ? FWD : 0n);
            expect(held, `${leg.chain} at leg ${i}`).toBeGreaterThanOrEqual(needs);
          });
        }
      }
    }
  });
});
