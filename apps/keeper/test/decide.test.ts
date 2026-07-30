import { describe, expect, it } from 'vitest';
import { decide, decideSalary, type Budget, type Candidate } from '../src/decide.js';

const SENDER = '0x46D060E22B84BFE396DF9CE61D5bA217ba6346C5' as const;
const NOW = 1_800_000_000;
const USDC = (whole: string) => BigInt(Math.round(Number(whole) * 1e6));

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    transferId: 1n,
    sender: SENDER,
    amount: USDC('1'),
    deadline: NOW - 60,
    status: 'PENDING',
    ...over,
  };
}

function budget(over: Partial<Budget> = {}): Budget {
  return {
    balance: USDC('5'),
    gasPerAction: USDC('0.02'),
    reserve: USDC('0.5'),
    maxActions: 10,
    ...over,
  };
}

describe('decide', () => {
  it('reclaims an expired pending transfer', () => {
    const c = candidate();
    expect(decide([c], budget(), NOW).act).toEqual([c]);
  });

  it('reclaims a locked transfer — five wrong guesses must not strand the money', () => {
    const c = candidate({ status: 'LOCKED' });
    expect(decide([c], budget(), NOW).act).toEqual([c]);
  });

  it.each(['CLAIMED', 'CANCELLED', 'RECLAIMED', 'NONE'] as const)(
    'skips a %s transfer, which the contract would revert on',
    (status) => {
      const d = decide([candidate({ status })], budget(), NOW);
      expect(d.act).toEqual([]);
      expect(d.skip[0]?.reason).toBe('not-reclaimable');
    },
  );

  it('leaves a transfer alone until its deadline has actually passed', () => {
    const d = decide([candidate({ deadline: NOW + 1 })], budget(), NOW);
    expect(d.act).toEqual([]);
    expect(d.skip[0]?.reason).toBe('not-expired');
  });

  it('acts the moment the deadline is behind us', () => {
    // The contract's gate is `block.timestamp <= deadline`, so equality is not yet
    // reclaimable but one second later is. Off-by-one here wastes a reverting tx.
    expect(decide([candidate({ deadline: NOW })], budget(), NOW).act).toEqual([]);
    expect(decide([candidate({ deadline: NOW - 1 })], budget(), NOW).act).toHaveLength(1);
  });

  it('declines to burn more gas than the money it would rescue', () => {
    const dust = candidate({ amount: USDC('0.01') });
    const d = decide([dust], budget({ gasPerAction: USDC('0.02') }), NOW);
    expect(d.act).toEqual([]);
    expect(d.skip[0]?.reason).toBe('not-worth-the-gas');
  });

  it('cannot be drained by a swarm of dust transfers', () => {
    const swarm = Array.from({ length: 500 }, (_, i) =>
      candidate({ transferId: BigInt(i), amount: USDC('0.001') }),
    );
    const d = decide(swarm, budget(), NOW);
    expect(d.act).toEqual([]);
    expect(d.skip.every((s) => s.reason === 'not-worth-the-gas')).toBe(true);
  });

  it('rescues the largest amounts first when the budget is short', () => {
    const small = candidate({ transferId: 1n, amount: USDC('1') });
    const large = candidate({ transferId: 2n, amount: USDC('50') });
    const mid = candidate({ transferId: 3n, amount: USDC('10') });
    // Room for exactly two actions.
    const b = budget({ balance: USDC('0.54'), reserve: USDC('0.5'), gasPerAction: USDC('0.02') });

    const d = decide([small, large, mid], b, NOW);
    expect(d.act.map((c) => c.transferId)).toEqual([2n, 3n]);
    expect(d.skip.find((s) => s.candidate.transferId === 1n)?.reason).toBe('out-of-budget');
  });

  it('never spends into the reserve it needs to draw its next salary', () => {
    const b = budget({ balance: USDC('0.5'), reserve: USDC('0.5') });
    const d = decide([candidate()], b, NOW);
    expect(d.act).toEqual([]);
    expect(d.skip[0]?.reason).toBe('out-of-budget');
  });

  it('caps how much it does in a single tick', () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate({ transferId: BigInt(i) }));
    const d = decide(many, budget({ maxActions: 3 }), NOW);
    expect(d.act).toHaveLength(3);
    expect(d.skip.filter((s) => s.reason === 'over-tick-limit')).toHaveLength(17);
  });

  it('accounts for every candidate exactly once', () => {
    const cs = [
      candidate({ transferId: 1n }),
      candidate({ transferId: 2n, status: 'CLAIMED' }),
      candidate({ transferId: 3n, deadline: NOW + 100 }),
      candidate({ transferId: 4n, amount: 1n }),
    ];
    const d = decide(cs, budget(), NOW);
    expect(d.act.length + d.skip.length).toBe(cs.length);
  });
});

describe('decideSalary', () => {
  const base = {
    balance: USDC('0.1'),
    lowWater: USDC('0.5'),
    targetBalance: USDC('1'),
    perPullMax: USDC('0.5'),
    remaining: USDC('5'),
    boxBalance: USDC('5'),
    nextPullAt: NOW - 1,
    nowSeconds: NOW,
  };

  it('tops up when the tank is low', () => {
    expect(decideSalary(base)).toEqual({ pull: true, amount: USDC('0.5') });
  });

  it('asks for the shortfall, not a full pull', () => {
    const r = decideSalary({
      ...base,
      balance: USDC('0.9'),
      lowWater: USDC('1'),
      targetBalance: USDC('1'),
      perPullMax: USDC('0.5'),
    });
    expect(r).toEqual({ pull: true, amount: USDC('0.1') });
  });

  it('does not draw a salary it does not need', () => {
    expect(decideSalary({ ...base, balance: USDC('2') })).toMatchObject({ pull: false });
  });

  it('waits for the interval the box enforces', () => {
    expect(decideSalary({ ...base, nextPullAt: NOW + 1 })).toMatchObject({ pull: false });
  });

  it('never exceeds the per-pull cap, whatever it is short by', () => {
    const r = decideSalary({ ...base, balance: 0n, targetBalance: USDC('100'), perPullMax: USDC('0.5') });
    expect(r).toEqual({ pull: true, amount: USDC('0.5') });
  });

  it('never asks for more than the box has left to give', () => {
    const r = decideSalary({ ...base, remaining: USDC('0.05'), boxBalance: USDC('5') });
    expect(r).toEqual({ pull: true, amount: USDC('0.05') });
  });

  it('never asks for more than the box actually holds', () => {
    const r = decideSalary({ ...base, boxBalance: USDC('0.03') });
    expect(r).toEqual({ pull: true, amount: USDC('0.03') });
  });

  it('stops asking once the budget is exhausted', () => {
    expect(decideSalary({ ...base, remaining: 0n })).toMatchObject({ pull: false });
  });
});
