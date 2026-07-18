import { createPublicClient, http, type Address } from 'viem';
import { arcTestnet, RPC_URL, CTRL_ARCZ_ADDRESS, ctrlArcZAbi } from '@ctrl-arcz/sdk';
import { push, tokensFor } from './notifications.js';

/**
 * The Arc event watcher. Polls the CtrlArcZ contract for the events that matter to
 * a user and turns them into push notifications:
 *   - TransferCreated to you  -> "you have a payment to claim"
 *   - TransferClaimed of yours -> "your transfer was claimed"
 * The poll range stays tiny (a few blocks per tick), so it never hits Arc's
 * eth_getLogs window cap and stays light on the public RPC.
 */
const client = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL, { retryCount: 4, retryDelay: 1500 }),
});

const POLL_MS = 15_000;
const senderOf = new Map<string, Address>(); // transferId -> sender, for claim notifications
let lastBlock: bigint | null = null;

async function tick(): Promise<void> {
  try {
    const current = await client.getBlockNumber();
    if (lastBlock === null) {
      lastBlock = current; // start from now; do not replay history on boot
      return;
    }
    if (current <= lastBlock) return;
    const fromBlock = lastBlock + 1n;

    const created = await client.getContractEvents({
      address: CTRL_ARCZ_ADDRESS,
      abi: ctrlArcZAbi,
      eventName: 'TransferCreated',
      fromBlock,
      toBlock: current,
    });
    for (const e of created) {
      const args = e.args as { transferId?: bigint; sender?: Address; to?: Address };
      if (args.transferId != null && args.sender) senderOf.set(args.transferId.toString(), args.sender);
      if (args.to && tokensFor(args.to).length > 0) {
        await push(args.to, 'Payment to claim', 'You have a protected transfer waiting. Open Receive to claim it.', {
          screen: 'Receive',
          transferId: args.transferId?.toString(),
        });
      }
    }

    const claimed = await client.getContractEvents({
      address: CTRL_ARCZ_ADDRESS,
      abi: ctrlArcZAbi,
      eventName: 'TransferClaimed',
      fromBlock,
      toBlock: current,
    });
    for (const e of claimed) {
      const args = e.args as { transferId?: bigint };
      const sender = args.transferId != null ? senderOf.get(args.transferId.toString()) : undefined;
      if (sender && tokensFor(sender).length > 0) {
        await push(sender, 'Transfer claimed', 'Your protected transfer was claimed.', {
          screen: 'Home',
          transferId: args.transferId?.toString(),
        });
      }
    }

    lastBlock = current;
  } catch (e) {
    console.error('watcher tick failed:', e instanceof Error ? e.message : e);
  }
}

export function startWatcher(): void {
  console.log('starting Arc event watcher');
  void tick();
  setInterval(() => void tick(), POLL_MS);
}
