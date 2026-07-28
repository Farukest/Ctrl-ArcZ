import { createPublicClient, fallback, http, type AbiEvent, type Address } from 'viem';
import { arcTestnet, RPC_URLS, CTRL_ARCZ_ADDRESS, ctrlArcZAbi } from '@ctrl-arcz/sdk';
import { push, tokensFor } from './notifications.js';

/**
 * The Arc event watcher. Polls the CtrlArcZ contract for the events that matter to
 * a user and turns them into push notifications:
 *   - TransferCreated to you  -> "you have a payment to claim"
 *   - TransferClaimed of yours -> "your transfer was claimed"
 * One bounded eth_getLogs per tick, over the same ranked RPC list the rest of the
 * app uses, so a single rate-limited endpoint cannot stall it.
 */
const client = createPublicClient({
  chain: arcTestnet,
  transport: fallback(RPC_URLS.map((u) => http(u, { retryCount: 1 }))),
});

const POLL_MS = 15_000;
/** Blocks scanned per tick. A tick that fails must not widen the next request:
 *  without a cap the range grows every 15s until every call is too big to serve
 *  and the watcher spends the rest of its life being rate-limited. Arc produces a
 *  couple of blocks a second, so this both covers a normal tick and lets a lagging
 *  cursor catch up over a few ticks. */
const MAX_SPAN = 500n;
const senderOf = new Map<string, Address>(); // transferId -> sender, for claim notifications
let lastBlock: bigint | null = null;

/** Both events in one request: two topics, one eth_getLogs per tick. */
const WATCHED = ctrlArcZAbi.filter(
  (i) => i.type === 'event' && (i.name === 'TransferCreated' || i.name === 'TransferClaimed'),
) as AbiEvent[];

async function tick(): Promise<void> {
  try {
    const current = await client.getBlockNumber();
    if (lastBlock === null) {
      lastBlock = current; // start from now; do not replay history on boot
      return;
    }
    if (current <= lastBlock) return;
    const fromBlock = lastBlock + 1n;
    const toBlock = current - fromBlock >= MAX_SPAN ? fromBlock + MAX_SPAN - 1n : current;

    const logs = await client.getLogs({
      address: CTRL_ARCZ_ADDRESS,
      events: WATCHED,
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
      const args = log.args as { transferId?: bigint; sender?: Address; to?: Address };
      if (log.eventName === 'TransferCreated') {
        if (args.transferId != null && args.sender) {
          senderOf.set(args.transferId.toString(), args.sender);
        }
        if (args.to && tokensFor(args.to).length > 0) {
          await push(args.to, 'Payment to claim', 'You have a protected transfer waiting. Open Receive to claim it.', {
            screen: 'Receive',
            transferId: args.transferId?.toString(),
          });
        }
      } else {
        const sender = args.transferId != null ? senderOf.get(args.transferId.toString()) : undefined;
        if (sender && tokensFor(sender).length > 0) {
          await push(sender, 'Transfer claimed', 'Your protected transfer was claimed.', {
            screen: 'Home',
            transferId: args.transferId?.toString(),
          });
        }
      }
    }

    lastBlock = toBlock;
  } catch (e) {
    console.error('watcher tick failed:', e instanceof Error ? e.message : e);
  }
}

export function startWatcher(): void {
  console.log('starting Arc event watcher');
  void tick();
  setInterval(() => void tick(), POLL_MS);
}
