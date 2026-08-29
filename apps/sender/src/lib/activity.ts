/**
 * Everything this browser has moved, as it moves it.
 *
 * The screens used to keep a run in React state and write it down afterwards, if
 * at all. That made progress something only the screen that started it could see,
 * and only for as long as it stayed on that screen: a deposit's steps vanished
 * when it finished, a reload lost them mid-flight, and a second deposit had
 * nowhere to go because the one slot on screen was taken.
 *
 * A run is a record from its first moment instead. It is written when it starts,
 * rewritten as each step happens, and closed when it ends, so the list is live by
 * construction rather than by a component remembering to refresh. Two runs at once
 * are two rows. A reload picks up where the screen left off. And there is one
 * answer to "what has this wallet been doing", which is the file the list reads.
 *
 * Everything lands in the same store as the bridge history because it is the same
 * question; `kind` is what tells a deposit from a transfer from a subscription.
 */
import { useEffect, useState } from 'react';
import { chainForStep, classifyFailure, type BridgeEngine } from '@ctrl-arcz/demo-kit';
import type { Address } from 'viem';
import {
  chainExplorerTxUrl,
  chainLabel,
  gatewayBalance,
  type CctpChainName,
  type GatewayChain,
} from '@ctrl-arcz/sdk';
import { loadPendingDeposits, pendingOn, reconcile } from './pendingDeposits.js';
import {
  dropBridge,
  loadBridges,
  saveBridge,
  type StoredBridge,
  type StoredBridgeStep,
} from '../store.js';

/**
 * How long a run may go without a write before a record left behind by a closed
 * tab is told apart from one that is genuinely still going.
 *
 * A run interrupted between the signature and the receipt leaves `running` in the
 * store with nothing alive to ever finish it, and the row would claim to be in
 * progress for good. The other reason a run is quiet is that it is waiting on a
 * person, at a wallet prompt, and that can take a while; two minutes is longer
 * than any step takes on its own and shorter than anyone stares at a stalled row.
 */
const STALL_MS = 2 * 60 * 1000;

/** Runs already in the store when this page loaded, which no promise here owns. */
const orphans = new Set<string>();
let orphansTaken = false;

function takeOrphans(): void {
  if (orphansTaken) return;
  orphansTaken = true;
  for (const b of loadBridges()) if (b.state === 'running') orphans.add(b.id);
}

/**
 * Whether a record is a run this page cannot possibly still be performing.
 *
 * Told from ownership rather than from age alone: a run this page started is live
 * however long its wallet prompt sits unanswered, and a run it did not start is
 * over whatever its record says. Age only guards the case of a second tab, which
 * did start it and is still writing to it.
 */
export function isStalled(b: StoredBridge): boolean {
  if (b.state !== 'running') return false;
  takeOrphans();
  if (!orphans.has(b.id)) return false;
  return Date.now() - (b.updatedAt ?? b.createdAt) > STALL_MS;
}

/** Everything, newest first, with interrupted runs recognised as such. */
export function loadActivity(): StoredBridge[] {
  takeOrphans();
  return loadBridges();
}

/**
 * Why a stored run failed, in the language on screen now.
 *
 * Rows are read long after they are written, so the sentence is made at the
 * moment it is shown rather than kept in the record. Anything from before this
 * existed, and anything Circle reported in its own words, still has only the
 * text it was written with, and that is what it shows.
 */
export function failureNote(
  b: StoredBridge,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | undefined {
  if (b.failureCode) return t(`failure.${b.failureCode}`);
  return b.failureReason;
}

const listeners = new Set<() => void>();

function announce(): void {
  for (const fn of listeners) fn();
}

/**
 * Tell every list on screen to look again.
 *
 * For the writes that go straight to the store rather than through a run handle:
 * the recovery pass and the completion handlers call `saveBridge` directly, and
 * without this their rows would only appear on the fifteen second sweep. It used
 * to be a `setState` in the screen that made the write, which worked while that
 * screen drew its own copy of the list and stopped meaning anything when the list
 * moved to the Activity screen.
 */
export function refreshActivity(): void {
  announce();
}

/** Write, then tell every list on screen. */
function put(bridge: StoredBridge): void {
  saveBridge({ ...bridge, updatedAt: Date.now() });
  announce();
}

/**
 * The activity list, kept current.
 *
 * Subscribes to writes from this page and to `storage`, which fires for the other
 * tabs of the same site. Two tabs on the same wallet is not an exotic case -- it
 * is what happens when someone opens the docs in a second tab -- and a deposit
 * made in one of them belongs in the list shown by the other.
 */
export function useActivity(): StoredBridge[] {
  const [items, setItems] = useState<StoredBridge[]>(() => loadActivity());
  useEffect(() => {
    const refresh = () => setItems(loadActivity());
    listeners.add(refresh);
    window.addEventListener('storage', refresh);
    // A row's own age decides whether it is stalled, and nothing writes when a run
    // simply stops, so the list has to look again on its own.
    const timer = setInterval(refresh, 15_000);
    return () => {
      listeners.delete(refresh);
      window.removeEventListener('storage', refresh);
      clearInterval(timer);
    };
  }, []);
  return items;
}

export interface RunHandle {
  id: string;
  /** This step has started. What the row's spinner sits on. */
  begin(step: string): void;
  /** This step is done, with the transaction it produced when it made one. */
  done(step: string, txHash?: string): void;
  /** This step was not needed. Drawn as a dash, never as a tick. */
  skip(step: string): void;
  /** Still going, in a way that is no longer this page's to advance. */
  waiting(): void;
  finish(): void;
  /**
   * Whatever was thrown, not a sentence made from it.
   *
   * The row keeps the symptom rather than the wording, so it still reads in the
   * language chosen after the failure rather than the one in use during it.
   */
  fail(step: string, cause?: unknown): void;
  /** Anything the run learns about itself after it starts, such as a recipient. */
  amend(patch: Partial<StoredBridge>): void;
  /**
   * Take the identity the run turned out to have.
   *
   * A Gateway spend is written down before the wallet prompt, under an id invented
   * here, because that is the moment the row is most needed and Circle has not been
   * asked yet. When Circle answers it returns a transferId, and that is the name the
   * mint is looked up by for as long as the transfer exists. So the row moves to it,
   * carrying its steps, and the invented name is dropped.
   *
   * `id` on this handle follows, so a caller holding the handle keeps pointing at
   * the row rather than at where it used to be.
   */
  rekey(nextId: string): void;
}

export interface StartRun {
  kind?: 'deposit' | 'subscription';
  engine: BridgeEngine;
  from: CctpChainName;
  to: CctpChainName;
  /** Display units. */
  amount: string;
  label?: string;
  recipient?: string;
  /** Only when the run has a natural identity of its own, such as a transferId. */
  id?: string;
}

function newId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Open a record for something that is about to happen.
 *
 * The id is generated rather than taken from the first transaction, because there
 * is no transaction yet and the row has to exist before there is one -- that is
 * the moment it is most needed, when a wallet prompt is open and the screen would
 * otherwise be saying nothing. A run with an identity of its own, like a Gateway
 * transferId, passes it in so recovery can still find it later.
 */
export function startRun(input: StartRun): RunHandle {
  let id = input.id ?? newId();
  const base: StoredBridge = {
    id,
    engine: input.engine,
    ...(input.kind ? { kind: input.kind } : {}),
    from: input.from,
    to: input.to,
    fromLabel: chainLabel(input.from),
    toLabel: chainLabel(input.to),
    ...(input.label ? { label: input.label } : {}),
    ...(input.recipient ? { recipient: input.recipient } : {}),
    amount: input.amount,
    state: 'running',
    steps: [],
    createdAt: Date.now(),
  };
  put(base);

  const current = (): StoredBridge => loadBridges().find((b) => b.id === id) ?? base;

  const write = (step: StoredBridgeStep) => {
    const b = current();
    put({ ...b, steps: [...b.steps.filter((s) => s.name !== step.name), step] });
  };

  /**
   * The link for a step, looked up on the chain that step actually ran on.
   *
   * This used `input.from` for everything, so a live row offered its mint on the
   * source chain's explorer while the transfer was still going. The finished row
   * was written separately with the right chain, which is why the link changed
   * under the reader when it landed instead of simply being right.
   */
  const link = (
    step: string,
    txHash?: string,
  ): Pick<StoredBridgeStep, 'txHash' | 'explorerUrl'> => {
    if (!txHash) return {};
    const chain = chainForStep(step, {
      from: input.from,
      to: input.to,
      ...(input.kind ? { kind: input.kind } : {}),
    });
    const url = chain ? chainExplorerTxUrl(chain, txHash) : undefined;
    return { txHash, ...(url ? { explorerUrl: url } : {}) };
  };

  return {
    // A getter, not a snapshot: `rekey` moves the row and every caller reading
    // `record.id` afterwards has to arrive at the row, not at its former address.
    get id() {
      return id;
    },
    begin: (step) => write({ name: step, state: 'active' }),
    done: (step, txHash) => write({ name: step, ...link(step, txHash) }),
    skip: (step) => write({ name: step, state: 'noop' }),
    waiting: () => put({ ...current(), state: 'pending' }),
    finish: () => put({ ...current(), state: 'success' }),
    fail: (step, cause) => {
      const b = current();
      const { code, detail } = classifyFailure(cause);
      put({
        ...b,
        state: 'error',
        ...(code === 'unknown' ? {} : { failureCode: code }),
        ...(detail ? { failureReason: detail } : {}),
        steps: [...b.steps.filter((s) => s.name !== step), { name: step, state: 'error' }],
      });
    },
    amend: (patch) => put({ ...current(), ...patch }),
    rekey: (nextId) => {
      if (!nextId || nextId === id) return;
      const b = current();
      dropBridge(id);
      id = nextId;
      put({ ...b, id: nextId });
    },
  };
}

/**
 * Close off the deposits on a chain this browser is no longer waiting for.
 *
 * Circle credits a total, not a deposit, so the only thing a browser can see of
 * the counting is that total going up. `pendingOn` is what watches it, and zero
 * for a chain means every deposit recorded against it has been credited.
 *
 * Read from the pending store rather than from a handle held by whatever made the
 * deposit, so this still settles a deposit made before a reload -- the case where
 * a row would otherwise wait for good. Those entries expire after a day, which is
 * the outer bound on how long a row can claim to still be waiting.
 */
export function settleCountedDeposits(chain: CctpChainName): boolean {
  let changed = false;
  for (const b of loadBridges()) {
    if (b.kind !== 'deposit' || b.state !== 'pending' || b.from !== chain) continue;
    put({
      ...b,
      state: 'success',
      steps: [...b.steps.filter((s) => s.name !== 'counted'), { name: 'counted' }],
    });
    changed = true;
  }
  return changed;
}

/**
 * Finish the deposits Circle has counted, wherever the reader happens to be.
 *
 * This used to live in the balance poll of the screen with the deposit box on it,
 * which meant the last step of a deposit only completed while that screen was
 * open. Measured on a real deposit: it sat on "Counted by Circle" for five minutes
 * with the bridge screen's other tab showing, and finished four seconds after
 * switching back. The money had been credited the whole time; the row was waiting
 * on a poll that was not running.
 *
 * So it runs once, for the whole app, and only when there is something to settle:
 * no pending deposit, no polling. Being the only settler also matters -- two of
 * them watching the same balance would each credit the same rise, and the pending
 * note would go to zero twice as fast as the money arrived.
 */
const SETTLE_POLL_MS = 12_000;

export function useSettleDeposits(address: Address | undefined): void {
  useEffect(() => {
    if (!address) return;
    let live = true;
    const tick = async () => {
      const waiting = loadPendingDeposits();
      if (waiting.length === 0) return;
      let byChain: Partial<Record<GatewayChain, bigint>>;
      try {
        ({ byChain } = await gatewayBalance({ depositor: address }));
      } catch {
        // A poll that fails leaves the row waiting, which is the honest answer.
        return;
      }
      if (!live) return;
      for (const chain of new Set(waiting.map((w) => w.chain))) {
        /*
         * Judged on this reading alone, against the figure each deposit is
         * waiting for. It used to be judged on the difference from the previous
         * reading, which meant the very first poll could only establish a
         * baseline -- and on Arc, where Circle credits in about a second against
         * a twelve second poll, the credit was already inside that baseline. No
         * later poll saw a rise, so the row waited for good on money it already
         * had. A reload re-took the baseline and reproduced it exactly.
         */
        reconcile(chain, byChain[chain] ?? 0n);
        if (pendingOn(chain) === 0n) settleCountedDeposits(chain);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), SETTLE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [address]);
}
