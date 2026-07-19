import type { Address, PublicClient } from 'viem';
import { ctrlArcZAbi } from '../abi/ctrlArcZ.js';
import { CTRL_ARCZ_ADDRESS } from '../chains/arcTestnet.js';
import { getLogsChunked } from '../events.js';

type RvArgs = { sender?: Address; recipient?: Address };

/**
 * A dedicated in-memory index of the contract's `RecipientVerified` events, keyed
 * by sender. It backfills once from the deploy block, then polls incrementally
 * over small bounded ranges, so the firewall (`check`) can be handed a sender's
 * verified recipients instantly (`verifiedRecipients` option) instead of scanning
 * the chain on every request. Run one per server process.
 */
export class VerifiedRecipientIndex {
  private readonly bySender = new Map<string, Set<Address>>();
  private lastBlock: bigint | null = null;
  private started = false;
  private backfilled = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly contractAddress: Address = CTRL_ARCZ_ADDRESS,
    private readonly pollMs = 15_000,
  ) {}

  /** The sender's verified recipients as indexed so far. Instant, no RPC. */
  recipientsOf(sender: Address): Address[] {
    return [...(this.bySender.get(sender.toLowerCase()) ?? [])];
  }

  /** True once the initial backfill has completed, so `recipientsOf` is complete
   *  (not just partial). Callers can fall back to a bounded scan until then. */
  isReady(): boolean {
    return this.backfilled;
  }

  private ingest(logs: Array<{ args: RvArgs }>): void {
    for (const log of logs) {
      const s = log.args.sender?.toLowerCase();
      const r = log.args.recipient;
      if (!s || !r) continue;
      let set = this.bySender.get(s);
      if (!set) {
        set = new Set<Address>();
        this.bySender.set(s, set);
      }
      set.add(r);
    }
  }

  /** Backfill once from the deploy block, then poll incrementally. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const logs = await getLogsChunked<RvArgs>(this.client, {
        address: this.contractAddress,
        abi: ctrlArcZAbi,
        eventName: 'RecipientVerified',
      });
      this.ingest(logs);
      this.lastBlock = await this.client.getBlockNumber();
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
      const logs = await getLogsChunked<RvArgs>(this.client, {
        address: this.contractAddress,
        abi: ctrlArcZAbi,
        eventName: 'RecipientVerified',
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
