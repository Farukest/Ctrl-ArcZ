import type { Address, Hex, PublicClient } from 'viem';
import { stealthAnnouncerAbi } from './abi.js';
import { STEALTH_ANNOUNCER_ADDRESS, STEALTH_ANNOUNCER_DEPLOY_BLOCK } from '../chains/arcTestnet.js';
import { STEALTH_SCHEME_ID } from './stealth.js';
import { getLogsChunked } from '../events.js';
import type { RawAnnouncement } from './stealthBox.js';

/**
 * An in-memory index of every stealth announcement, so a browser does not have to
 * read the chain to find its own boxes.
 *
 * The announcer is a single global registry: every stealth box anyone creates is
 * announced to it, and there is deliberately nothing on chain that says which
 * announcement belongs to whom. That is the property the whole feature exists for,
 * and it has a cost: finding your boxes means reading every announcement ever made
 * and testing each one against your viewing key. Measured on Arc, that span was
 * 2.16 million blocks -- 217 chunked `eth_getLogs` calls -- and it grows by about
 * 1.6 million blocks a day, so the wait grew by half a minute every day that
 * passed.
 *
 * This moves the reading to a server that does it once and then follows the chain,
 * exactly like {@link VerifiedRecipientIndex} does for the firewall.
 *
 * **What it deliberately does not do is recognise anything.** Recognition needs the
 * viewing key, the viewing key is derived from a wallet signature, and it never
 * leaves the browser. The index serves the same public announcements to everyone
 * and the client matches them locally, so the server cannot learn which boxes are
 * whose even if it wanted to. An endpoint that took a viewing key would be faster
 * to write and would hand away the only thing this design is protecting.
 */
export interface IndexedAnnouncement extends RawAnnouncement {
  /** The block it was announced in, so a client can ask for only what is new. */
  blockNumber: string;
}

type AnnouncementArgs = {
  stealthAddress?: Address;
  ephemeralPubKey?: Hex;
  metadata?: Hex;
};

export class AnnouncementIndex {
  /** In block order, which is the only honest ordering a stealth box has. */
  private readonly entries: IndexedAnnouncement[] = [];
  /** Guards against a re-org or an overlapping poll inserting a duplicate. */
  private readonly seen = new Set<string>();
  private lastBlock: bigint | null = null;
  private started = false;
  private backfilled = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly announcer: Address = STEALTH_ANNOUNCER_ADDRESS as Address,
    private readonly deployBlock: bigint = STEALTH_ANNOUNCER_DEPLOY_BLOCK,
    private readonly pollMs = 15_000,
  ) {}

  /**
   * Announcements at or after `fromBlock`, and the head they are complete to.
   *
   * `complete` is false until the backfill lands. A client that trusts an
   * incomplete index would show a subscription list that is missing boxes, which
   * reads exactly like not having them, so it has to fall back to reading the
   * chain itself until this is true.
   */
  since(fromBlock = 0n): {
    announcements: IndexedAnnouncement[];
    head: string | null;
    complete: boolean;
  } {
    return {
      announcements:
        fromBlock <= 0n
          ? [...this.entries]
          : this.entries.filter((e) => BigInt(e.blockNumber) >= fromBlock),
      head: this.lastBlock === null ? null : this.lastBlock.toString(),
      complete: this.backfilled,
    };
  }

  isReady(): boolean {
    return this.backfilled;
  }

  private ingest(
    logs: Array<{ args: AnnouncementArgs; blockNumber: bigint | null }>,
  ): void {
    for (const log of logs) {
      const { stealthAddress, ephemeralPubKey, metadata } = log.args;
      if (!stealthAddress || !ephemeralPubKey || !metadata) continue;
      // The stealth address is unique per announcement by construction, and this
      // also absorbs the one-block overlap a re-org can produce.
      const key = `${stealthAddress.toLowerCase()}:${ephemeralPubKey.toLowerCase()}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.entries.push({
        stealthAddress,
        ephemeralPubKey,
        metadata,
        blockNumber: (log.blockNumber ?? 0n).toString(),
      });
    }
  }

  private read(fromBlock: bigint, toBlock: bigint) {
    return getLogsChunked<AnnouncementArgs>(this.client, {
      address: this.announcer,
      abi: stealthAnnouncerAbi,
      eventName: 'Announcement',
      args: { schemeId: BigInt(STEALTH_SCHEME_ID) },
      fromBlock,
      toBlock,
    });
  }

  /** Backfill once from the announcer's deploy block, then poll. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      // Snapshot the head BEFORE scanning and resume from head+1, so an
      // announcement mined during the backfill cannot fall in a gap and be missed
      // forever while `complete` already reports true.
      const head = await this.client.getBlockNumber();
      this.ingest(await this.read(this.deployBlock, head));
      this.lastBlock = head;
      this.backfilled = true;
    } catch {
      // The poll will carry on from the next tick; `complete` stays false, so
      // clients keep reading the chain themselves rather than trusting a gap.
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
        // The backfill failed. Retry it rather than starting from here, which
        // would leave the index permanently missing everything before now.
        this.ingest(await this.read(this.deployBlock, current));
        this.lastBlock = current;
        this.backfilled = true;
        return;
      }
      if (current <= this.lastBlock) return;
      this.ingest(await this.read(this.lastBlock + 1n, current));
      this.lastBlock = current;
    } catch {
      // Retry on the next tick. The cursor is untouched, so nothing is skipped.
    }
  }
}
