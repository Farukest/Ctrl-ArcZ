/**
 * A stored run, as a row.
 *
 * The block that draws these knows nothing about chains, engines or Circle; it is
 * given rows and draws them the same way on every screen. This is where a record
 * becomes one, and it is the only place that has to know that a deposit's steps
 * are not a transfer's and that `pending` means two different waits depending on
 * which of them it is.
 */
import {
  deriveStepStatuses,
  stepExplorerUrl,
  stepsForRun,
  type BridgeEngine,
} from '@ctrl-arcz/demo-kit';
import type { CctpChainName } from '@ctrl-arcz/sdk';
import { ChainLogo, relativeTime, type ActivityItem, type RowTone } from '@ctrl-arcz/demo-kit/ui';
import { failureNote, isStalled } from './activity.js';
import type { StoredBridge } from '../store.js';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Which dictionary a run's step names live in. */
function stepKey(b: StoredBridge, name: string): string {
  if (b.kind === 'subscription') return `sub.step.${name}`;
  return `bridge.rowstep.${name}`;
}

/**
 * The word for where this run has got to.
 *
 * `pending` is deliberately not one word for everything. A deposit that is pending
 * is waiting on Circle counting confirmations, which is fine and takes as long as
 * the chain takes. A transfer that is pending has been burned and not yet minted,
 * which is also fine but is a different sentence, and the row has room to say the
 * right one.
 */
function stateOf(b: StoredBridge): { key: string; tone: RowTone } {
  if (isStalled(b)) return { key: 'bridge.state.stalled', tone: 'warn' };
  switch (b.state) {
    case 'success':
    case 'returned':
      return { key: 'bridge.state.success', tone: 'ok' };
    case 'error':
      return { key: 'bridge.state.error', tone: 'err' };
    case 'running':
      return { key: 'bridge.state.running', tone: 'idle' };
    case 'returning':
      return { key: 'bridge.state.returning', tone: 'idle' };
    default:
      return { key: 'bridge.state.pending', tone: 'idle' };
  }
}

/**
 * Whether the pill should point at this row.
 *
 * A run in progress and a run that failed, and nothing else. A deposit waiting on
 * Circle for nineteen minutes is not something to interrupt someone about -- they
 * were told how long it takes when they made it -- and neither is one that landed.
 * An interrupted run counts, because that is exactly the one nobody would think to
 * go back and look at.
 */
function attentionOf(b: StoredBridge): ActivityItem['attention'] {
  if (isStalled(b)) return 'failed';
  if (b.state === 'error') return 'failed';
  if (b.state === 'running') return 'running';
  return undefined;
}

/**
 * What kind of move this was, in one word.
 *
 * The rows carried a route, an amount and a status, and nothing said whether the
 * money had been deposited into the balance, spent from it, or burned and minted
 * across chains -- three different things that look identical when all you show is
 * two chain names.
 */
function kindChip(b: StoredBridge, t: T): string {
  if (b.kind === 'deposit') return t('bridge.rowstep.deposit');
  if (b.engine === 'cctp') return t('bridge.engine.cctp');
  return t('bridge.engine.gateway');
}

/**
 * The line under the row: what it was for, and what stopped it.
 *
 * Both when there are both, since a failed subscription funding is the one case
 * where knowing which subscription matters as much as knowing what went wrong.
 */
function noteOf(b: StoredBridge, t: T): { note?: string } {
  const why = failureNote(b, t);
  const note = [b.label, why].filter(Boolean).join(' - ');
  return note ? { note } : {};
}

export function toActivityItem(b: StoredBridge, t: T): ActivityItem {
  const engine: BridgeEngine = b.engine === 'cctp' ? 'cctp' : 'gateway';
  const names = stepsForRun(engine, b);
  // A run that has been interrupted is not still moving, whatever its record says,
  // so its unreported steps are drawn as never reached rather than as skipped.
  const run = isStalled(b) ? { ...b, state: 'failed' } : b;
  const statuses = deriveStepStatuses(names, run);
  const { key, tone } = stateOf(b);
  const sameChain = b.from === b.to;

  return {
    id: b.id,
    lead: (
      <>
        <ChainLogo id={b.from} size={18} />
        {b.fromLabel}
        {!sameChain && (
          <>
            <span className="hrow__arrow" aria-hidden>
              &rarr;
            </span>
            <ChainLogo id={b.to} size={18} />
            {b.toLabel}
          </>
        )}
      </>
    ),
    amount: `${b.amount} USDC`,
    kind: kindChip(b, t),
    ...(b.fee ? { fee: t('activity.feeIs', { fee: b.fee }) } : {}),
    status: { tone, label: t(key) },
    time: relativeTime(b.createdAt),
    ...noteOf(b, t),
    steps: names.map((name, i) => {
      const reported = b.steps.find((s) => s.name === name);
      return {
        label: t(stepKey(b, name)),
        status: statuses[i] ?? 'pending',
        ...(reported?.txHash ? { txHash: reported.txHash } : {}),
        // Derived, so a row written before an explorer existed still links now.
        ...(() => {
          const url = reported
            ? stepExplorerUrl(reported, {
                from: b.from as CctpChainName,
                to: b.to as CctpChainName,
                ...(b.kind ? { kind: b.kind } : {}),
              })
            : undefined;
          return url ? { explorerUrl: url } : {};
        })(),
      };
    }),
    ...(attentionOf(b) ? { attention: attentionOf(b) } : {}),
  };
}

/** The labels the block needs, in one place so no screen assembles its own. */
export function activityLabels(t: T, title: string) {
  return {
    title,
    empty: t('activity.empty'),
    all: t('activity.all'),
    running: t('activity.running'),
    failed: t('activity.failed'),
    fresh: t('activity.fresh'),
    jump: t('activity.jump'),
  };
}
