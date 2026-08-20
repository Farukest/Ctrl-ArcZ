/**
 * A Gateway deposit, written down the way every other movement of money is.
 *
 * A deposit used to leave nothing behind. Both screens drew a live stepper while it
 * ran and cleared it the moment it finished, so a successful deposit returned the
 * page to exactly the state it was in before the user did anything -- next to a
 * balance which, on Base, would not move for another twenty minutes. Nothing to
 * look at, nothing that survived a reload, and no transaction hash to check. The
 * toast said it had worked and then it, too, went away.
 *
 * The record goes in the same store as the transfers, so one list answers "what has
 * this wallet done" rather than two that each know half. `from` and `to` are the
 * same chain because that is what a deposit is: the money does not travel, it
 * changes what is allowed to spend it.
 *
 * Keyed by the deposit's own transaction hash, so the second write -- Circle has
 * counted it -- replaces the first rather than leaving a duplicate stuck on
 * pending. A deposit that never got as far as a transaction is not recorded at all:
 * nothing left the wallet, and a row saying otherwise would be worse than silence.
 */
import { chainExplorerTxUrl, chainLabel, type GatewayChain } from '@ctrl-arcz/sdk';
import { loadBridges, saveBridge, type StoredBridge, type StoredBridgeStep } from '../store.js';

export interface DepositRecordInput {
  chain: GatewayChain;
  /** Display units, as the history rows print them. */
  amount: string;
  /** Absent when the allowance already covered the deposit. */
  approveTxHash?: string;
  depositTxHash: string;
  /** `pending` until Circle credits it, then `success`. */
  state: 'pending' | 'success';
  createdAt: number;
}

/** One step row, carrying a link only where the chain publishes an explorer. */
function step(name: string, chain: GatewayChain, txHash?: string): StoredBridgeStep {
  const url = txHash ? chainExplorerTxUrl(chain, txHash) : undefined;
  return { name, ...(txHash ? { txHash } : {}), ...(url ? { explorerUrl: url } : {}) };
}

export function depositRecord(input: DepositRecordInput): StoredBridge {
  const label = chainLabel(input.chain);
  return {
    id: input.depositTxHash,
    engine: 'gateway',
    kind: 'deposit',
    from: input.chain,
    to: input.chain,
    fromLabel: label,
    toLabel: label,
    amount: input.amount,
    state: input.state,
    steps: [
      // The approval is listed even when it did not happen, because "you were not
      // asked to approve" is itself an answer to why there was only one prompt.
      ...(input.approveTxHash ? [step('approve', input.chain, input.approveTxHash)] : []),
      step('deposit', input.chain, input.depositTxHash),
      ...(input.state === 'success' ? [step('counted', input.chain)] : []),
    ],
    createdAt: input.createdAt,
  };
}

export function recordDeposit(input: DepositRecordInput): void {
  saveBridge(depositRecord(input));
}

/** Every deposit this browser has recorded, newest first. */
export function loadDeposits(): StoredBridge[] {
  return loadBridges().filter((b) => b.kind === 'deposit');
}

/**
 * Close off the deposits on a chain this browser is no longer waiting for.
 *
 * The counting is Circle's, and the only thing a browser can see of it is the
 * balance going up. `pendingOn` is what watches that, and when it reaches zero for
 * a chain every deposit recorded against that chain has been credited. This is the
 * write that turns those rows from waiting into done.
 *
 * Says whether it changed anything, so the caller can avoid re-reading the store
 * fifteen seconds at a time for the rest of the session.
 */
export function settleCountedDeposits(chain: GatewayChain): boolean {
  let changed = false;
  for (const b of loadDeposits()) {
    if (b.state !== 'pending' || b.from !== chain) continue;
    saveBridge({
      ...b,
      state: 'success',
      steps: [...b.steps.filter((s) => s.name !== 'counted'), { name: 'counted' }],
    });
    changed = true;
  }
  return changed;
}
