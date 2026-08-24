import type { Address, Hex, PublicClient } from 'viem';
import { spendPolicyFactoryAbi } from './abi.js';
import { getLogsChunked } from '../events.js';

type AcArgs = { account?: Address; ownerHash?: Hex };

/**
 * An in-memory index of the factory's `AccountCreated` events, mapping each spend
 * box to the `ownerHash` it was created under. It backfills once from the factory's
 * deploy block, then polls incrementally, so the co-signer can answer "does this
 * `owner` actually own this box?" from a map lookup rather than a chain scan.
 *
 * Why this exists: a deployed box stores no owner on chain (identity-free by
 * design), so the ONLY authoritative link between a box and its owner is this
 * event's indexed `ownerHash`. Without checking it, the co-signer would sign a
 * spend for anyone who names any box, since the box carries nothing to compare a
 * claimed owner against. Run one per server process, per chain.
 */
export class AccountOwnerIndex {
  private readonly byAccount = new Map<string, Hex>();
  private lastBlock: bigint | null = null;
  private started = false;
  private backfilled = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly factory: Address,
    private readonly deployBlock: bigint,
    private readonly pollMs = 15_000,
  ) {}

  /** The ownerHash a box was created under, or null if this index has never seen it. */
  ownerHashOf(account: Address): Hex | null {
    return this.byAccount.get(account.toLowerCase()) ?? null;
  }

  /** True once the initial backfill has completed, so a miss means "unknown box",
   *  not "not scanned yet". The co-signer fails closed until this is true. */
  isReady(): boolean {
    return this.backfilled;
  }

  private ingest(logs: Array<{ args: AcArgs }>): void {
    for (const log of logs) {
      const a = log.args.account?.toLowerCase();
      const oh = log.args.ownerHash;
      if (!a || !oh) continue;
      this.byAccount.set(a, oh);
    }
  }

  /** Backfill once from the deploy block, then poll incrementally. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      // Snapshot the head before scanning, scan up to it, resume from head+1: an event
      // mined during the scan must not fall in the gap while isReady() reports complete.
      const head = await this.client.getBlockNumber();
      const logs = await getLogsChunked<AcArgs>(this.client, {
        address: this.factory,
        abi: spendPolicyFactoryAbi,
        eventName: 'AccountCreated',
        fromBlock: this.deployBlock,
        toBlock: head,
      });
      this.ingest(logs);
      this.lastBlock = head;
      this.backfilled = true;
    } catch {
      // Backfill failed (RPC blip); the incremental poll will start from the next tick.
    }
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      const current = await this.client.getBlockNumber();
      if (this.lastBlock == null) {
        this.lastBlock = current;
        return;
      }
      if (current <= this.lastBlock) return;
      const logs = await getLogsChunked<AcArgs>(this.client, {
        address: this.factory,
        abi: spendPolicyFactoryAbi,
        eventName: 'AccountCreated',
        fromBlock: this.lastBlock + 1n,
        toBlock: current,
      });
      this.ingest(logs);
      this.lastBlock = current;
    } catch {
      // Retry on the next tick.
    }
  }
}
