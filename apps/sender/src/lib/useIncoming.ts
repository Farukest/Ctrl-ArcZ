import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, PublicClient } from 'viem';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import {
  ctrlArcZAbi,
  CTRL_ARCZ_ADDRESS,
  getLogsChunked,
  getTransfer,
  type ProtectedTransfer,
} from '@ctrl-arcz/sdk';

/** How far back the received history reaches. Deep enough to cover the life of a
 *  demo wallet, shallow enough to stay a handful of eth_getLogs. */
const LOOKBACK = 200_000n;
const POLL_MS = 15_000;

export interface IncomingTransfer {
  transferId: bigint;
  transfer: ProtectedTransfer;
  /** Block the transfer was created in, so the list can be ordered without a
   *  per-transfer timestamp read. */
  block: bigint;
  /**
   * When that block was mined, in epoch ms.
   *
   * Ordering only needs the block number, but a history needs a date: without one
   * the list cannot be filtered by day or grouped under one, and deriving a time
   * from a block height would put transfers on the wrong side of midnight. Blocks
   * are read once each and cached, so a page of transfers from the same block
   * costs a single call.
   */
  at: number;
}

/**
 * Every protected transfer addressed to this wallet, whatever state it ended in.
 *
 * The pending list answers "what can I claim now"; this answers "what has ever been
 * sent to me", which is the question a history screen exists for. Status comes from
 * the chain rather than from anything this browser remembers, so it is the same on a
 * fresh device.
 */
/**
 * Block timestamps, read once per block and remembered for the session.
 *
 * Falls back to now when the read fails, which keeps a row visible and sorted at
 * the top rather than dropping it or dating it to 1970. A wrong-but-recent date on
 * an unreadable block is a smaller lie than either alternative.
 */
const blockTimes = new Map<string, number>();

async function blockTime(client: PublicClient, block: bigint): Promise<number> {
  const key = block.toString();
  const known = blockTimes.get(key);
  if (known != null) return known;
  try {
    const b = await client.getBlock({ blockNumber: block });
    const ms = Number(b.timestamp) * 1000;
    blockTimes.set(key, ms);
    return ms;
  } catch {
    return Date.now();
  }
}

export function useIncoming(session: Session | null): {
  rows: IncomingTransfer[] | null;
  reload: () => Promise<void>;
} {
  const [rows, setRows] = useState<IncomingTransfer[] | null>(null);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (!session) {
      setRows(null);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    const client = getPublicClient();
    const me = session.address.toLowerCase();
    try {
      const latest = await client.getBlockNumber();
      const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0n;
      const logs = await getLogsChunked<{ to?: Address; transferId?: bigint }>(client, {
        address: CTRL_ARCZ_ADDRESS,
        abi: ctrlArcZAbi,
        eventName: 'TransferCreated',
        args: { to: session.address as Address },
        fromBlock,
        toBlock: latest,
      });
      const seen = new Map<string, bigint>();
      for (const l of logs) {
        if (l.args.to?.toLowerCase() !== me) continue;
        const id = l.args.transferId?.toString();
        if (id && !seen.has(id)) seen.set(id, (l as { blockNumber?: bigint }).blockNumber ?? 0n);
      }
      const resolved = await Promise.all(
        [...seen].map(async ([id, block]) => {
          const [transfer, at] = await Promise.all([
            getTransfer({ publicClient: client }, BigInt(id)).catch(() => null),
            blockTime(client, block),
          ]);
          return transfer ? { transferId: BigInt(id), transfer, block, at } : null;
        }),
      );
      setRows(
        resolved
          .filter((r): r is IncomingTransfer => r !== null)
          .sort((a, b) => Number(b.transferId - a.transferId)),
      );
    } catch {
      setRows([]);
    } finally {
      inFlight.current = false;
    }
  }, [session]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [reload]);

  return { rows, reload };
}
