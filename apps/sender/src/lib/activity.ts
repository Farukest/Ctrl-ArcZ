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
import type { BridgeEngine } from '@ctrl-arcz/demo-kit';
import { chainExplorerTxUrl, chainLabel, type CctpChainName } from '@ctrl-arcz/sdk';
import { loadBridges, saveBridge, type StoredBridge, type StoredBridgeStep } from '../store.js';

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
 * A failure in as many words as a row has space for.
 *
 * A viem error's `message` is a page: the request arguments, the decoded contract
 * call, a docs link and a version, all of which belong in a console and none of
 * which belongs in a list of five rows. `shortMessage` is the sentence at the top
 * of it -- "User rejected the request." -- and it is the whole of what a person
 * needs to know about the row. The cap is for anything else that throws a novel.
 */
export function reasonOf(e: unknown): string {
  const short = (e as { shortMessage?: unknown })?.shortMessage;
  const text =
    typeof short === 'string' && short.length > 0
      ? short
      : e instanceof Error
        ? e.message
        : String(e);
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

const listeners = new Set<() => void>();

function announce(): void {
  for (const fn of listeners) fn();
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
  fail(step: string, reason?: string): void;
  /** Anything the run learns about itself after it starts, such as a recipient. */
  amend(patch: Partial<StoredBridge>): void;
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
  const id = input.id ?? newId();
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

  const link = (txHash?: string): Pick<StoredBridgeStep, 'txHash' | 'explorerUrl'> => {
    if (!txHash) return {};
    const url = chainExplorerTxUrl(input.from, txHash);
    return { txHash, ...(url ? { explorerUrl: url } : {}) };
  };

  return {
    id,
    begin: (step) => write({ name: step, state: 'active' }),
    done: (step, txHash) => write({ name: step, ...link(txHash) }),
    skip: (step) => write({ name: step, state: 'noop' }),
    waiting: () => put({ ...current(), state: 'pending' }),
    finish: () => put({ ...current(), state: 'success' }),
    fail: (step, reason) => {
      const b = current();
      put({
        ...b,
        state: 'error',
        ...(reason ? { failureReason: reason } : {}),
        steps: [...b.steps.filter((s) => s.name !== step), { name: step, state: 'error' }],
      });
    },
    amend: (patch) => put({ ...current(), ...patch }),
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
