/**
 * The receiving side's presentation rules, with no React around them.
 *
 * What a status *means* is the SDK's (`isClaimable`, `statusBucket` and friends).
 * What it looks like, how long ago it was, what a search box should match and when
 * an arrival is worth announcing are this layer's, and each of them was a few
 * lines inside a component until it turned out to be wrong in a way that looking
 * at the screen never revealed.
 */
import { formatUnits } from 'viem';
import type { ProtectedTransfer, TransferStatus } from '@ctrl-arcz/sdk';
import type { RowTone } from './HistoryRow.js';

/** Same four tones every history uses, so the lists read alike. */
export function statusTone(status: TransferStatus): RowTone {
  if (status === 'CLAIMED') return 'ok';
  // Cancelled and reclaimed are both "you are not getting this", and a row that
  // ended that way must not read like one that is still waiting.
  if (status === 'CANCELLED' || status === 'RECLAIMED') return 'err';
  if (status === 'LOCKED') return 'warn';
  return 'idle';
}

/**
 * How long ago, in the shortest form that is still unambiguous.
 *
 * Floored, never rounded. Rounding claims more time has passed than actually has:
 * with `Math.round`, something sent 2 days and 14 hours ago read "3d" and sat under
 * a date header two days old, and 36 hours read "2d". On a screen where the number
 * next to a transfer is how long its claim window has been running, a label that
 * runs ahead of the clock is the one mistake this field must not make.
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(1, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Everything searchable about a received row, so one box matches an amount, a
 *  sender or an id. */
export function receivedHaystack(row: {
  transferId: bigint;
  transfer: Pick<ProtectedTransfer, 'amount' | 'sender' | 'status'>;
}): string {
  return [
    row.transferId.toString(),
    formatUnits(row.transfer.amount, 6),
    'usdc',
    row.transfer.sender,
    row.transfer.status,
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Whether a payment has just arrived, as a value rather than a pile of refs.
 *
 * Two things it must never do, both of which it used to. It must not announce a
 * first reading: opening the app with transfers already waiting is not three
 * payments arriving at once. And it must not treat "I could not read the chain"
 * as "there is nothing waiting" -- a failed poll passes `null`, and the poll that
 * recovers would otherwise announce everything that was already sitting there.
 */
export interface ArrivalState {
  /** A first successful reading has happened and is the baseline. */
  seeded: boolean;
  count: number;
}

export const NO_ARRIVALS: ArrivalState = { seeded: false, count: 0 };

export function nextArrival(
  state: ArrivalState,
  claimable: readonly unknown[] | null,
): { state: ArrivalState; announce: boolean } {
  if (claimable === null) return { state, announce: false };
  const count = claimable.length;
  if (!state.seeded) return { state: { seeded: true, count }, announce: false };
  return { state: { seeded: true, count }, announce: count > state.count };
}
