/**
 * Four kinds of record, one row shape.
 *
 * This is the only place that knows a protected transfer has a claim code, that
 * an explorer entry has a direction, that a bridge run has steps and that a
 * subscription funding carries a merchant's name. Everything downstream -- the
 * search, the chips, the paging, the row, the detail behind it -- sees
 * `ActivityEntry` and nothing else.
 *
 * Each mapper builds the haystack itself, because only it knows what somebody
 * would type to find one of its rows: a transfer id for a send, a token symbol
 * for a history line, a chain name for a bridge, a merchant for a subscription.
 */
import { formatUnits } from 'viem';
import { explorerTxUrl, type HistoryEntry, type ProtectedTransfer } from '@ctrl-arcz/sdk';
import {
  deriveStepStatuses,
  stepsForRun,
  type ActivityEntry,
  type ActivityStep,
  type ActivityTone,
  type BridgeEngine,
} from '@ctrl-arcz/demo-kit';
import { isStalled } from './activity.js';
import type { StoredBridge, StoredTransfer } from '../store.js';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The four lists this screen can show. Also the facet namespace of each. */
export type ActivityKind = 'sent' | 'history' | 'bridge' | 'subs';

function lower(parts: readonly (string | number | undefined | null)[]): string {
  return parts
    .filter((p) => p != null && p !== '')
    .join(' ')
    .toLowerCase();
}

/* ---- Sent: protected transfers this browser created ---------------------- */

export interface SentRow {
  stored: StoredTransfer;
  /** What the chain says about it, or null when it could not be read. */
  chain: ProtectedTransfer | null;
}

/**
 * A protected transfer's status is the chain's, never this browser's.
 *
 * The store knows what was sent; only the contract knows whether it was claimed,
 * cancelled or left to expire, and a row that trusted the store would keep
 * claiming "pending" for a transfer somebody collected on another device.
 */
function sentTone(status: string): ActivityTone {
  if (status === 'CLAIMED') return 'ok';
  // The contract's word for a transfer the sender took back, which is what
  // cancelling one does. An older version of this compared against `CANCELLED`
  // and `EXPIRED`, neither of which the chain has ever returned, so a refunded
  // transfer had been rendering in the neutral tone since the day it was written.
  if (status === 'RECLAIMED') return 'err';
  if (status === 'LOCKED') return 'warn';
  return 'idle';
}

export function sentEntries(rows: readonly SentRow[], t: T): ActivityEntry[] {
  return rows.map(({ stored, chain }) => {
    const status = chain?.status ?? 'NONE';
    const undoable = status === 'PENDING' || status === 'LOCKED';
    const amount = Number(stored.amount);
    const facets = [
      undoable ? 'undoable' : '',
      status === 'PENDING' ? 'pending' : '',
      status === 'RECLAIMED' ? 'refunded' : '',
      status === 'CLAIMED' ? 'claimed' : '',
    ].filter(Boolean);

    return {
      id: `sent-${stored.transferId}`,
      at: stored.createdAt ?? 0,
      magnitude: Number.isFinite(amount) ? amount : 0,
      haystack: lower([`#${stored.transferId}`, stored.amount, 'usdc', stored.to, status]),
      facets,
      view: {
        icon: { kind: 'status', tone: sentTone(status) },
        title: `#${stored.transferId}`,
        subtitle: stored.to,
        amount: `${stored.amount} USDC`,
        status: { tone: sentTone(status), label: t(`active.status.${status.toLowerCase()}`) },
      },
      facts: [
        { label: t('activity.to'), value: stored.to, copy: true, mono: true },
        ...(stored.txHash
          ? [
              {
                label: t('bridge.rowReceipt'),
                value: stored.txHash,
                copy: true,
                mono: true,
                href: explorerTxUrl(stored.txHash),
              },
            ]
          : []),
      ],
      // Only while it is still this wallet's to undo. A cancelled transfer with a
      // cancel button is a button that exists to be refused.
      actions: undoable
        ? [{ id: 'cancel', label: t('active.cancel'), tone: 'danger' as const }]
        : [],
    };
  });
}

/* ---- History: what the chain itself recorded ----------------------------- */

export function historyEntries(entries: readonly HistoryEntry[], t: T): ActivityEntry[] {
  return entries.map((e) => {
    const amount = formatUnits(e.amount, e.decimals);
    const incoming = e.direction === 'in';
    const party =
      e.kind === 'transfer'
        ? e.counterparty
        : e.kind === 'burn'
          ? t('history.burned')
          : e.method === 'receiveMessage'
            ? t('history.bridgedInCctp')
            : e.method === 'gatewayMint'
              ? t('history.bridgedInGateway')
              : t('history.bridgedIn');

    return {
      id: `hist-${e.txHash}-${e.direction}-${e.counterparty}`,
      at: e.timestamp.getTime(),
      magnitude: Number(amount),
      haystack: lower([
        e.counterparty,
        amount,
        e.tokenSymbol,
        e.txHash,
        e.direction,
        e.kind,
        e.method,
        e.kind === 'mint' ? 'bridge bridged in mint' : '',
      ]),
      facets: [incoming ? 'received' : 'sent', `token:${e.tokenSymbol.toLowerCase()}`],
      view: {
        icon: { kind: 'token', symbol: e.tokenSymbol, direction: incoming ? 'in' : 'out' },
        title: t(incoming ? 'history.received' : 'history.sent'),
        subtitle: party,
        amount: `${incoming ? '+' : '-'}${amount} ${e.tokenSymbol}`,
      },
      facts: [
        {
          label: t(incoming ? 'activity.from' : 'activity.to'),
          value: party,
          copy: e.kind === 'transfer',
          mono: e.kind === 'transfer',
        },
        {
          label: t('bridge.rowReceipt'),
          value: e.txHash,
          copy: true,
          mono: true,
          href: explorerTxUrl(e.txHash),
        },
      ],
    };
  });
}

/* ---- Bridge and subscriptions: runs this browser performed ---------------- */

function bridgeTone(b: StoredBridge): ActivityTone {
  if (isStalled(b)) return 'warn';
  if (b.state === 'success' || b.state === 'returned') return 'ok';
  if (b.state === 'error') return 'err';
  return 'idle';
}

function bridgeStateKey(b: StoredBridge): string {
  if (isStalled(b)) return 'bridge.state.stalled';
  if (b.state === 'success' || b.state === 'returned') return 'bridge.state.success';
  if (b.state === 'error') return 'bridge.state.error';
  if (b.state === 'running') return 'bridge.state.running';
  if (b.state === 'returning') return 'bridge.state.returning';
  return 'bridge.state.pending';
}

/** The chip that says how the money moved: a deposit, CCTP, or Gateway. */
function routeChip(b: StoredBridge, t: T): string {
  if (b.kind === 'deposit') return t('bridge.rowstep.deposit');
  if (b.kind === 'subscription') return t('bridge.engine.gateway');
  return t(b.engine === 'cctp' ? 'bridge.engine.cctp' : 'bridge.engine.gateway');
}

/**
 * A run's steps, in the order that run has them, with what is true of each.
 *
 * The step list and the status rules are the shared ones, so this row and the
 * block at the bottom of the bridge screen cannot end up describing the same
 * transfer differently. An interrupted run is drawn as stopped rather than
 * moving: whatever its record says, this page is not the one performing it.
 */
function stepsOf(b: StoredBridge, t: T): ActivityStep[] {
  const engine: BridgeEngine = b.engine === 'cctp' ? 'cctp' : 'gateway';
  const names = stepsForRun(engine, b);
  const statuses = deriveStepStatuses(names, isStalled(b) ? { ...b, state: 'failed' } : b);
  const prefix = b.kind === 'subscription' ? 'sub.step.' : 'bridge.rowstep.';
  return names.map((name, i) => {
    const reported = b.steps.find((s) => s.name === name);
    return {
      label: t(`${prefix}${name}`),
      state: (statuses[i] ?? 'pending') as ActivityStep['state'],
      ...(reported?.txHash ? { txHash: reported.txHash } : {}),
      ...(reported?.explorerUrl ? { href: reported.explorerUrl } : {}),
    };
  });
}

export function bridgeEntries(bridges: readonly StoredBridge[], t: T): ActivityEntry[] {
  return bridges.map((b) => {
    const chip = routeChip(b, t);
    const sameChain = b.from === b.to;
    const amount = Number(b.amount);
    const facets = [
      b.state === 'success' || b.state === 'returned' ? 'arrived' : '',
      b.kind === 'deposit' ? 'deposit' : b.engine === 'cctp' ? 'cctp' : 'gateway',
      b.state === 'error' || isStalled(b) ? 'failed' : '',
    ].filter(Boolean);

    const receipt = b.steps.find((s) => s.txHash);
    return {
      id: b.id,
      at: b.createdAt,
      magnitude: Number.isFinite(amount) ? amount : 0,
      haystack: lower([
        b.fromLabel,
        b.toLabel,
        b.amount,
        'usdc',
        b.label,
        chip,
        b.state,
        b.recipient,
        b.id,
      ]),
      facets,
      view: {
        icon: sameChain
          ? { kind: 'chain' as const, id: b.from }
          : { kind: 'route' as const, from: b.from, to: b.to },
        // Where it ended up. The mark to the left already shows both chains, and
        // spelling the route out again cost the row a second line on a phone to
        // say what the two logos beside it had just said.
        title: b.toLabel,
        ...(b.label ? { subtitle: b.label } : {}),
        amount: `${b.amount} USDC`,
        chips: [chip],
        status: { tone: bridgeTone(b), label: t(bridgeStateKey(b)) },
      },
      facts: [
        { label: t('cost.amount'), value: `${b.amount} USDC` },
        { label: t('bridge.rowTo'), value: b.toLabel },
        ...(b.recipient
          ? [{ label: t('sub.d.merchant'), value: b.recipient, copy: true, mono: true }]
          : []),
        ...(b.failureReason ? [{ label: t('bridge.rowReason'), value: b.failureReason }] : []),
        ...(receipt?.txHash
          ? [
              {
                label: t('bridge.rowReceipt'),
                value: receipt.txHash,
                copy: true,
                mono: true,
                ...(receipt.explorerUrl ? { href: receipt.explorerUrl } : {}),
              },
            ]
          : []),
      ],
      steps: stepsOf(b, t),
    };
  });
}

/** A transfer whose destination is one of this wallet's subscription boxes. */
export function isSubscriptionRun(b: StoredBridge, boxes: ReadonlySet<string>): boolean {
  if (b.kind === 'subscription') return true;
  return b.recipient !== undefined && boxes.has(b.recipient.toLowerCase());
}
