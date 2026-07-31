import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { CachingDataProvider } from '../src/risk/cachingProvider.js';
import type { CounterpartyScan, IDataProvider } from '../src/risk/types.js';

const SENDER = '0x46D060E22B84BFE396DF9CE61D5bA217ba6346C5' as Address;
const OTHER = '0xAfBb17a34Bde0A2E2f01f2A87597891D2A295ddB' as Address;

function stub(behaviour: () => Promise<CounterpartyScan>) {
  const calls = { counterparties: 0, activity: 0, bait: 0 };
  const inner: IDataProvider = {
    async getOutgoingCounterparties() {
      calls.counterparties++;
      return behaviour();
    },
    async getAddressActivity() {
      calls.activity++;
      return { transactionCount: 1, firstSeenAt: null };
    },
    async countZeroValueTransfers() {
      calls.bait++;
      return 0;
    },
  };
  return { inner, calls };
}

const complete = (): Promise<CounterpartyScan> =>
  Promise.resolve({ counterparties: [OTHER], complete: true });

describe('CachingDataProvider', () => {
  it('fetches once and serves the rest from cache', async () => {
    const { inner, calls } = stub(complete);
    const p = new CachingDataProvider(inner);
    await p.getOutgoingCounterparties(SENDER);
    await p.getOutgoingCounterparties(SENDER);
    await p.getOutgoingCounterparties(SENDER);
    expect(calls.counterparties).toBe(1);
  });

  it('refetches once the entry goes stale', async () => {
    let clock = 0;
    const { inner, calls } = stub(complete);
    const p = new CachingDataProvider(inner, { ttlMs: 1000, now: () => clock });
    await p.getOutgoingCounterparties(SENDER);
    clock = 999;
    await p.getOutgoingCounterparties(SENDER);
    expect(calls.counterparties).toBe(1);
    clock = 1001;
    await p.getOutgoingCounterparties(SENDER);
    expect(calls.counterparties).toBe(2);
  });

  it('caches per sender, never across them', async () => {
    const { inner, calls } = stub(complete);
    const p = new CachingDataProvider(inner);
    await p.getOutgoingCounterparties(SENDER);
    await p.getOutgoingCounterparties(OTHER);
    expect(calls.counterparties).toBe(2);
  });

  it('treats a checksummed and lowercase address as the same sender', async () => {
    const { inner, calls } = stub(complete);
    const p = new CachingDataProvider(inner);
    await p.getOutgoingCounterparties(SENDER);
    await p.getOutgoingCounterparties(SENDER.toLowerCase() as Address);
    expect(calls.counterparties).toBe(1);
  });

  it('never caches a failure — that is what keeps the firewall failing closed', async () => {
    let attempt = 0;
    const { inner, calls } = stub(async () => {
      attempt++;
      if (attempt === 1) throw new Error('indexer down');
      return { counterparties: [OTHER], complete: true };
    });
    const p = new CachingDataProvider(inner);

    await expect(p.getOutgoingCounterparties(SENDER)).rejects.toThrow('indexer down');
    // The next call must reach the indexer again, not inherit a cached "safe".
    await expect(p.getOutgoingCounterparties(SENDER)).resolves.toMatchObject({ complete: true });
    expect(calls.counterparties).toBe(2);
  });

  it('never caches an incomplete scan, so a missing counterparty gets another chance', async () => {
    const { inner, calls } = stub(async () => ({ counterparties: [], complete: false }));
    const p = new CachingDataProvider(inner);
    await p.getOutgoingCounterparties(SENDER);
    await p.getOutgoingCounterparties(SENDER);
    expect(calls.counterparties).toBe(2);
  });

  it('collapses concurrent calls into one request', async () => {
    let release: (v: CounterpartyScan) => void = () => {};
    const gate = new Promise<CounterpartyScan>((r) => { release = r; });
    const { inner, calls } = stub(() => gate);
    const p = new CachingDataProvider(inner);

    const all = Promise.all([
      p.getOutgoingCounterparties(SENDER),
      p.getOutgoingCounterparties(SENDER),
      p.getOutgoingCounterparties(SENDER),
    ]);
    release({ counterparties: [OTHER], complete: true });
    await all;
    expect(calls.counterparties).toBe(1);
  });

  it('lets a new request through after a concurrent batch rejects', async () => {
    let attempt = 0;
    const { inner, calls } = stub(async () => {
      attempt++;
      if (attempt === 1) throw new Error('boom');
      return { counterparties: [], complete: true };
    });
    const p = new CachingDataProvider(inner);
    await Promise.allSettled([
      p.getOutgoingCounterparties(SENDER),
      p.getOutgoingCounterparties(SENDER),
    ]);
    await p.getOutgoingCounterparties(SENDER);
    expect(calls.counterparties).toBe(2);
  });

  it('does not cache the target-side lookups', async () => {
    const { inner, calls } = stub(complete);
    const p = new CachingDataProvider(inner);
    await p.getAddressActivity(OTHER);
    await p.getAddressActivity(OTHER);
    await p.countZeroValueTransfers(OTHER, SENDER);
    await p.countZeroValueTransfers(OTHER, SENDER);
    expect(calls.activity).toBe(2);
    expect(calls.bait).toBe(2);
  });

  it('forgets everything on clear, for a wallet change', async () => {
    const { inner, calls } = stub(complete);
    const p = new CachingDataProvider(inner);
    await p.getOutgoingCounterparties(SENDER);
    p.clear();
    await p.getOutgoingCounterparties(SENDER);
    expect(calls.counterparties).toBe(2);
  });
});
