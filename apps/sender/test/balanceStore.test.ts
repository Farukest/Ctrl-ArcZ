import { describe, expect, it } from 'vitest';
import { bumpBalances, createBalanceStore } from '../src/lib/balanceStore.js';

/**
 * The shared balance store, and in particular when it decides a held value has
 * stopped being true.
 *
 * Two axes, and only one of them used to exist. Money moving is the obvious one.
 * The other is the vantage point: some balances can only be read from a
 * particular network, so "cannot be read from here" is a successful read of a
 * real condition, gets cached like any other value, and then the condition
 * changes underneath it. The key does not change, because the Base balance is
 * the Base balance wherever the wallet stands, so nothing invalidated it and the
 * cache went on serving an answer that had stopped being true.
 */

/** Lets a test await whatever the store kicked off, without reaching inside it. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a value is stale when the conditions it was read under change', () => {
  /**
   * The wallet-USDC store in miniature: the value is keyed by the chain being
   * asked about, but can only be read while the wallet is standing on it.
   */
  function walletLike() {
    let reads = 0;
    const store = createBalanceStore<{ chain: string; on: string }, bigint | null>({
      keyOf: (a) => a.chain,
      contextOf: (a) => a.on,
      read: async (a) => {
        reads += 1;
        return a.on === a.chain ? 42n : null;
      },
    });
    return { store, reads: () => reads };
  }

  it('re-reads after the wallet moves onto the chain being asked about', async () => {
    /*
     * The bug, exactly as it reached the screen: the deposit box on Base Sepolia,
     * with the wallet on Base Sepolia, saying it could not read the balance, under
     * a note promising a retry that was never going to come.
     */
    const { store, reads } = walletLike();
    const away = { chain: 'Base', on: 'Arc' };
    store.subscribe(away, () => {});
    await settle();
    expect(store.snapshot(away).value).toBeNull();
    expect(store.snapshot(away).resolved).toBe(true);

    // The wallet switches to Base. Same key, new vantage point.
    const here = { chain: 'Base', on: 'Base' };
    store.subscribe(here, () => {});
    await settle();
    expect(store.snapshot(here).value).toBe(42n);
    expect(reads()).toBe(2);
  });

  it('does not re-read while the conditions hold', async () => {
    // The other half: this is a cache, and a re-render is not a reason to re-ask.
    const { store, reads } = walletLike();
    const args = { chain: 'Base', on: 'Base' };
    store.subscribe(args, () => {});
    await settle();
    store.subscribe(args, () => {});
    store.subscribe({ chain: 'Base', on: 'Base' }, () => {});
    await settle();
    expect(reads()).toBe(1);
  });

  it('keeps the last-known figure while it re-reads, rather than blanking', async () => {
    /*
     * Why the vantage point is not simply part of the key. Keyed by both, a switch
     * away and back would land on a fresh entry with nothing in it, and the figure
     * would flash to a skeleton every time someone changed networks. Keyed by
     * identity, the number stays on screen and is corrected behind.
     */
    const { store } = walletLike();
    const here = { chain: 'Base', on: 'Base' };
    store.subscribe(here, () => {});
    await settle();
    expect(store.snapshot(here).value).toBe(42n);

    const away = { chain: 'Base', on: 'Arc' };
    store.subscribe(away, () => {});
    // Synchronously after the switch, before the read comes back.
    expect(store.snapshot(away).value).toBe(42n);
  });

  it('still re-reads when money moves, conditions unchanged', async () => {
    let reads = 0;
    const store = createBalanceStore<{ who: string }, number>({
      keyOf: (a) => a.who,
      read: async () => ++reads,
    });
    const args = { who: 'a' };
    store.subscribe(args, () => {});
    await settle();
    expect(store.snapshot(args).value).toBe(1);

    bumpBalances();
    await settle();
    expect(store.snapshot(args).value).toBe(2);
  });

  it('leaves a failed read stale, so the next look asks again', async () => {
    // A throw is not an answer. Without this a dash sits there for good.
    let attempts = 0;
    const store = createBalanceStore<{ who: string }, number>({
      keyOf: (a) => a.who,
      read: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('rpc down');
        return 7;
      },
    });
    const args = { who: 'a' };
    store.subscribe(args, () => {});
    await settle();
    expect(store.snapshot(args).value).toBeUndefined();

    store.subscribe(args, () => {});
    await settle();
    expect(store.snapshot(args).value).toBe(7);
  });
});
