import { BaseError, ContractFunctionRevertedError } from 'viem';
import type { RiskReport } from '../risk/types.js';

/** Base class so integrators can `catch (e) { if (e instanceof CtrlArcZError) ... }`. */
export class CtrlArcZError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Why an action on a transfer could not proceed. Stable codes so a UI can localize
 * without parsing messages. Raised instead of a raw viem revert so end users never
 * see contract internals.
 */
export type TransferUnavailableReason = 'not_pending' | 'expired' | 'unknown' | 'not_sender';

const UNAVAILABLE_MESSAGE: Record<TransferUnavailableReason, string> = {
  not_pending: 'This transfer is no longer available (already claimed, cancelled, or refunded).',
  expired: 'This transfer has expired.',
  unknown: 'No such transfer.',
  not_sender: 'Only the sender can cancel this transfer.',
};

/** A claim/cancel/reclaim could not run because of the transfer's on-chain state. */
export class TransferUnavailableError extends CtrlArcZError {
  constructor(readonly reason: TransferUnavailableReason) {
    super(UNAVAILABLE_MESSAGE[reason]);
  }
}

/** Decodes a viem revert into the contract's custom error name, or null. */
export function decodeRevert(err: unknown): { name?: string; args?: readonly unknown[] } | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    const out: { name?: string; args?: readonly unknown[] } = {};
    if (revert.data?.errorName) out.name = revert.data.errorName;
    if (revert.data?.args) out.args = revert.data.args;
    return out;
  }
  return null;
}

/**
 * The proof was rejected. The transaction itself succeeded — `claim` cannot revert
 * on a wrong code without rolling back the attempt counter it must record — so the
 * SDK turns the failure into an exception, which is what callers expect.
 */
export class WrongClaimCodeError extends CtrlArcZError {
  constructor(
    readonly transferId: bigint,
    readonly attemptsRemaining: number,
    readonly txHash: `0x${string}`,
  ) {
    super(
      attemptsRemaining > 0
        ? `Wrong code. Attempts remaining: ${attemptsRemaining}.`
        : 'Wrong code. No attempts left; the transfer is locked and only the sender can cancel.',
    );
  }
}

/** Five wrong guesses were made: the transfer is frozen and only `cancel` remains. */
export class TransferLockedError extends CtrlArcZError {
  constructor(
    readonly transferId: bigint,
    readonly txHash: `0x${string}`,
  ) {
    super(
      'Transfer locked (5 wrong attempts). The funds are safe: only the sender can cancel and reclaim them.',
    );
  }
}

/** The transaction mined but produced neither a success nor a failure event. */
export class ClaimOutcomeUnknownError extends CtrlArcZError {
  constructor(readonly txHash: `0x${string}`) {
    super(`The claim was mined but its outcome could not be read: ${txHash}`);
  }
}

/**
 * A send was attempted while the risk firewall said `block`.
 *
 * Carries the whole `RiskReport`, not just its messages, so a caller that catches
 * this can render the same explanation the pre-send UI would have shown: the rule
 * codes, which address the target imitates (`lookalikeOf`), and whether the scan
 * was complete. `reasons` is kept as the flattened message list for logging.
 */
export class RiskBlockedError extends CtrlArcZError {
  readonly reasons: string[];

  constructor(readonly report: RiskReport) {
    const reasons = report.reasons.map((r) => r.message);
    super(`The risk scan stopped the send:\n- ${reasons.join('\n- ')}`);
    this.reasons = reasons;
  }
}
