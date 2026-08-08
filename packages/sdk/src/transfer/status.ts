/**
 * What a transfer's status means, as functions rather than as conditions copied
 * into whichever screen needed them.
 *
 * `TransferStatus` says what the chain recorded. It does not say what a person can
 * do about it, and the gap between those two is where the receiving side kept
 * going wrong: a transfer whose claim window has closed still reads PENDING, so
 * every list that trusted the status alone counted it as something the recipient
 * was waiting for, and offered a button that could only spend gas to revert.
 */
import type { ProtectedTransfer, TransferStatus } from './transfer.js';

/** Statuses a transfer never leaves. Anything else can still change. */
export const TERMINAL_STATUSES: ReadonlySet<TransferStatus> = new Set<TransferStatus>([
  'CLAIMED',
  'CANCELLED',
  'RECLAIMED',
]);

export function isTerminal(status: TransferStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Still open on the chain: the money is in the contract and its fate is undecided. */
export function isOpen(status: TransferStatus): boolean {
  return status === 'PENDING' || status === 'LOCKED';
}

/**
 * Can the recipient settle this right now?
 *
 * The contract refuses a claim past the deadline, and LOCKED means the five code
 * attempts are gone. Everything else about a transfer can be true and it still
 * will not settle, so this is the only question a "waiting for you" count should
 * be asking.
 */
export function isClaimable(
  transfer: Pick<ProtectedTransfer, 'status' | 'deadline'>,
  now: number = Date.now(),
): boolean {
  return transfer.status === 'PENDING' && transfer.deadline.getTime() > now;
}

/**
 * A transfer whose window has lapsed while the money is still in the contract.
 *
 * The chain has no status for this: it stays PENDING until somebody calls
 * `reclaimExpired`. It is the one state a recipient can see and act on that no
 * status pill names, and it never overlaps with `isClaimable`.
 */
export function isReturnable(
  transfer: Pick<ProtectedTransfer, 'status' | 'deadline'>,
  now: number = Date.now(),
): boolean {
  return isOpen(transfer.status) && now > transfer.deadline.getTime();
}

export type StatusBucket = 'pending' | 'claimed' | 'cancelled' | 'expired';

/**
 * The four groups a person sorts transfers into, which are not the five the chain
 * records. LOCKED sits with pending: the money is still there and the sender can
 * still cancel it.
 */
export function statusBucket(status: TransferStatus): StatusBucket {
  if (status === 'CLAIMED') return 'claimed';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'RECLAIMED') return 'expired';
  return 'pending';
}
