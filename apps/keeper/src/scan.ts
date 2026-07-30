import type { Address, PublicClient } from 'viem';
import { CTRL_ARCZ_ADDRESS, ctrlArcZAbi, getLogsChunked, getTransfer } from '@ctrl-arcz/sdk';
import type { Candidate } from './decide.js';

/**
 * The keeper's view of which transfers are still open.
 *
 * Built from events rather than by polling every transfer id, because the set of
 * transfers only grows and re-reading all of them every minute would be the same
 * RPC storm the app already had to fix once. `TransferCreated` carries the
 * amount, sender and deadline, so an open transfer needs no state read at all
 * until its deadline actually passes.
 *
 * The ledger is a hint, never the authority. Before spending gas the keeper
 * re-reads the transfer from chain, because an event gap (a dropped tick, a
 * pruned RPC) would otherwise let it broadcast a transaction the contract will
 * revert.
 */

interface OpenTransfer {
  transferId: bigint;
  sender: Address;
  amount: bigint;
  deadline: number;
}

type CreatedArgs = {
  transferId?: bigint;
  sender?: Address;
  amount?: bigint;
  deadline?: bigint;
};
type SettledArgs = { transferId?: bigint };

/** The three ways a transfer leaves the open set. Locked is NOT one of them: a
 *  frozen transfer still holds funds and is still reclaimable after its window. */
const SETTLING_EVENTS = ['TransferClaimed', 'TransferCancelled', 'TransferReclaimed'] as const;

export class OpenLedger {
  private readonly open = new Map<string, OpenTransfer>();
  private cursor: bigint | null = null;

  constructor(private readonly contract: Address = CTRL_ARCZ_ADDRESS as Address) {}

  get size(): number {
    return this.open.size;
  }

  /** The block this ledger has consumed up to, or null before the first sync. */
  get syncedTo(): bigint | null {
    return this.cursor;
  }

  /**
   * Bring the ledger up to `head`. The first call backfills `backfillBlocks`;
   * later calls read only what is new, capped at `spanBlocks` so a tick that
   * failed cannot make the next request larger — the failure mode that
   * previously turned a rate-limit blip into a permanently stuck watcher.
   */
  async sync(
    client: PublicClient,
    head: bigint,
    opts: { backfillBlocks: number; spanBlocks: number },
  ): Promise<void> {
    const first = this.cursor === null;
    const from = first
      ? head > BigInt(opts.backfillBlocks)
        ? head - BigInt(opts.backfillBlocks)
        : 0n
      : this.cursor! + 1n;
    if (from > head) return;

    const span = BigInt(opts.spanBlocks);
    const to = !first && head - from >= span ? from + span - 1n : head;

    const created = await getLogsChunked<CreatedArgs>(client, {
      address: this.contract,
      abi: ctrlArcZAbi,
      eventName: 'TransferCreated',
      fromBlock: from,
      toBlock: to,
    });
    for (const log of created) {
      const { transferId, sender, amount, deadline } = log.args;
      if (transferId == null || !sender || amount == null || deadline == null) continue;
      this.open.set(transferId.toString(), {
        transferId,
        sender,
        amount,
        deadline: Number(deadline),
      });
    }

    for (const eventName of SETTLING_EVENTS) {
      const settled = await getLogsChunked<SettledArgs>(client, {
        address: this.contract,
        abi: ctrlArcZAbi,
        eventName,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of settled) {
        if (log.args.transferId != null) this.open.delete(log.args.transferId.toString());
      }
    }

    this.cursor = to;
  }

  /** Open transfers whose deadline has passed, largest first, capped. */
  expired(nowSeconds: number, limit: number): OpenTransfer[] {
    const past: OpenTransfer[] = [];
    for (const t of this.open.values()) if (nowSeconds > t.deadline) past.push(t);
    past.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
    return past.slice(0, limit);
  }

  /** Drop a transfer the keeper has settled or found already settled. */
  forget(transferId: bigint): void {
    this.open.delete(transferId.toString());
  }
}

/**
 * Confirm each candidate against chain state before any gas is spent. The
 * ledger's amount and sender come from the creation event and cannot change, but
 * `status` can — so status is the field that has to be authoritative, and it is
 * the one the contract gates on.
 */
export async function confirm(
  client: PublicClient,
  contract: Address,
  open: OpenTransfer[],
): Promise<Candidate[]> {
  const confirmed: Candidate[] = [];
  for (const t of open) {
    try {
      const chain = await getTransfer({ publicClient: client, contractAddress: contract }, t.transferId);
      confirmed.push({
        transferId: chain.transferId,
        sender: chain.sender,
        amount: chain.amount,
        deadline: Math.floor(chain.deadline.getTime() / 1000),
        status: chain.status,
      });
    } catch {
      // A read failure is not evidence the transfer is reclaimable. Leave it in
      // the ledger and let the next tick decide with fresh data.
    }
  }
  return confirmed;
}
