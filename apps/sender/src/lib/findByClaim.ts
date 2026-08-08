import type { Address, Hex, PublicClient } from 'viem';
import { ctrlArcZAbi, CTRL_ARCZ_ADDRESS, getLogsChunked } from '@ctrl-arcz/sdk';

/** How far back a claim code can find its transfer. Recall windows are hours, so a
 *  claimable transfer is always recent; this keeps the scan to a few calls. */
const LOOKBACK = 200_000n;

export interface FoundTransfer {
  transferId: bigint;
  to: Address;
  sender: Address;
  amount: bigint;
  /**
   * When the claim window closes, in epoch ms.
   *
   * Carried by the same event, so it costs nothing to return, and it is the
   * difference between offering a button that works and one that reverts: the
   * contract refuses a claim past this point.
   */
  deadline: number;
}

/**
 * Find the transfer a claim code belongs to, from the commitment alone.
 *
 * The code is the whole proof, so it should be enough on its own: no transfer
 * number to type, and no need to be connected as the recipient. `claim` is
 * permissionless and always pays the recipient recorded at send time, so whoever
 * holds the code can settle it and the money still cannot be redirected. That is a
 * contract guarantee, not a UI one, so the UI has no reason to demand a particular
 * wallet.
 *
 * `claimHash` is in the event data rather than a topic, so this scans a bounded
 * window and matches client-side. It runs once per entered code, not on a poll.
 */
export async function findByClaimHash(
  client: PublicClient,
  claimHash: Hex,
): Promise<FoundTransfer | null> {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0n;
  const logs = await getLogsChunked<{
    transferId?: bigint;
    to?: Address;
    sender?: Address;
    amount?: bigint;
    deadline?: bigint;
    claimHash?: Hex;
  }>(client, {
    address: CTRL_ARCZ_ADDRESS,
    abi: ctrlArcZAbi,
    eventName: 'TransferCreated',
    fromBlock,
    toBlock: latest,
  });
  const want = claimHash.toLowerCase();
  const hit = logs.find((l) => l.args.claimHash?.toLowerCase() === want);
  if (!hit?.args.transferId || !hit.args.to || !hit.args.sender) return null;
  return {
    transferId: hit.args.transferId,
    to: hit.args.to,
    sender: hit.args.sender,
    amount: hit.args.amount ?? 0n,
    deadline: Number(hit.args.deadline ?? 0n) * 1000,
  };
}
