/**
 * One balance, one reader -- the web counterpart of the native `TokenBalanceStore`.
 *
 * Every tab used to read its own balances on mount, so switching between Bridge
 * and Subscriptions blanked the figure and re-fetched it each time, and the blocks
 * jumped as the number and the note under them arrived at different moments. This
 * holds each balance in one place instead, keyed and shared, outside the tab that
 * shows it, so the value survives a tab unmounting.
 *
 * The three properties that make it stable, all lifted from the native store:
 *
 *  - `Resolved`: "never asked" (show a skeleton) is kept apart from "asked and
 *    could not read" (show a dash) and "have a figure". A screen that cannot tell
 *    those apart flickers a placeholder into an error into a value on every visit.
 *  - Stale-while-revalidate: a re-mounting tab shows the last-known figure at once
 *    and re-reads behind it. Values are kept for the life of the process; reads
 *    are not.
 *  - One bus. Anything that moves money calls {@link bumpBalances}; every store
 *    then re-reads only what is currently on screen (a live subscriber), not the
 *    twenty chains nobody is looking at.
 *
 * Reads are de-duplicated (`reading`) and a signal that lands mid-read is kept
 * (`missed`) rather than dropped, so a slow or failing read cannot strand a value
 * on a dash with nothing left to ask again.
 */
import { useSyncExternalStore } from 'react';

/**
 * A value plus whether it has ever come back. `resolved: false` is "never asked";
 * a resolved `value === undefined` is "asked and could not read".
 */
export type Resolved<V> = { readonly value: V | undefined; readonly resolved: boolean };

/** The single shared "never asked" snapshot, so an unread key is a stable ref. */
const UNKNOWN: Resolved<never> = { value: undefined, resolved: false };
export function unknownBalance<V>(): Resolved<V> {
  return UNKNOWN;
}

// One bus for the whole app. Every store registers an invalidator here; anything
// that moves money calls bumpBalances() and each store re-reads its watched keys.
const busListeners = new Set<() => void>();
export function bumpBalances(): void {
  for (const fn of busListeners) fn();
}

type Entry<A, V> = {
  args: A;
  state: Resolved<V>;
  /** Generation of the last successful read; below the store's means stale. */
  readAt: number;
  /**
   * The conditions the held value was read under (see `contextOf`). Different
   * from the current conditions means stale, however recent the read was.
   */
  readContext: string;
  reading: boolean;
  missed: boolean;
  listeners: Set<() => void>;
};

export interface BalanceStore<A, V> {
  subscribe: (args: A, onChange: () => void) => () => void;
  snapshot: (args: A) => Resolved<V>;
}

export function createBalanceStore<A, V>(opts: {
  keyOf: (args: A) => string;
  read: (args: A) => Promise<V>;
  /**
   * What, besides the key, the value depended on when it was read.
   *
   * Some balances can only be read from certain vantage points: the wallet's USDC
   * on Base can only be asked for while the wallet is on Base, and from anywhere
   * else the honest answer is "cannot be read from here". That answer is a
   * successful read of a real condition, so it gets cached like any other -- and
   * then the condition changes, the key does not, and the cache serves an answer
   * that stopped being true.
   *
   * Which is exactly what happened: switch the wallet to Base Sepolia and the
   * deposit box went on saying it could not read a balance it could now read
   * perfectly well, under a note promising a retry that was never going to come,
   * because `generation` only advances when money moves and changing networks is
   * not money moving.
   *
   * So the key stays the identity of the value -- the Base balance is the Base
   * balance wherever you stand, and keeping it keyed that way is what lets the
   * last-known figure survive a switch instead of blanking -- and this carries the
   * conditions. When they change, the entry is stale.
   */
  contextOf?: (args: A) => string;
}): BalanceStore<A, V> {
  const entries = new Map<string, Entry<A, V>>();
  const contextOf = opts.contextOf ?? (() => '');
  // A counter, not a clock: staleness is "money moved since this was read", an
  // event, not a duration.
  let generation = 0;

  const emit = (e: Entry<A, V>) => {
    for (const fn of e.listeners) fn();
  };

  const read = async (e: Entry<A, V>): Promise<void> => {
    // Both stamped before the read: a bump or a network switch that lands mid-read
    // leaves this stale, which is correct -- the figure was taken before it moved.
    const at = generation;
    const ctx = contextOf(e.args);
    let value: V | undefined;
    let ok = false;
    try {
      value = await opts.read(e.args);
      ok = true;
    } catch {
      // Keep the last-known value rather than blanking on one failed read.
    }
    e.state = { value: ok ? value : e.state.value, resolved: true };
    // Only a read that came back counts as done, so a failure stays stale and the
    // next subscribe or bump asks again instead of the dash sitting forever.
    if (ok) {
      if (at > e.readAt) e.readAt = at;
      e.readContext = ctx;
    }
    emit(e);
  };

  const ensureFresh = (e: Entry<A, V>): void => {
    if (e.readAt >= generation && e.readContext === contextOf(e.args)) return;
    if (e.reading) {
      e.missed = true;
      return;
    }
    e.reading = true;
    void (async () => {
      try {
        do {
          e.missed = false;
          await read(e);
        } while (e.missed && e.readAt < generation);
      } finally {
        e.reading = false;
      }
    })();
  };

  const entryFor = (args: A): Entry<A, V> => {
    const key = opts.keyOf(args);
    let e = entries.get(key);
    if (!e) {
      e = {
        args,
        state: UNKNOWN,
        readAt: -1,
        readContext: '',
        reading: false,
        missed: false,
        listeners: new Set(),
      };
      entries.set(key, e);
    } else {
      // Same key can arrive with equal-but-new args (address cased differently);
      // keep the latest so a re-read uses current inputs.
      e.args = args;
    }
    return e;
  };

  busListeners.add(() => {
    generation++;
    for (const e of entries.values()) if (e.listeners.size > 0) ensureFresh(e);
  });

  return {
    subscribe(args, onChange) {
      const e = entryFor(args);
      e.listeners.add(onChange);
      // Read on the transition into being watched, exactly where the interest is,
      // and only when stale. A value that went stale while the tab was away is
      // shown at once and re-read behind.
      ensureFresh(e);
      return () => {
        e.listeners.delete(onChange);
      };
    },
    // Pure: never creates an entry, so React can call it on every render.
    snapshot(args) {
      return entries.get(opts.keyOf(args))?.state ?? UNKNOWN;
    },
  };
}

/** Subscribe a component to one keyed balance. `args === null` reads nothing. */
export function useBalance<A, V>(store: BalanceStore<A, V>, args: A | null): Resolved<V> {
  return useSyncExternalStore(
    (onChange) => (args !== null ? store.subscribe(args, onChange) : () => {}),
    () => (args !== null ? store.snapshot(args) : UNKNOWN),
    () => UNKNOWN,
  );
}
