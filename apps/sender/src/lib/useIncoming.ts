import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, PublicClient } from 'viem';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import {
  ctrlArcZAbi,
  CTRL_ARCZ_ADDRESS,
  getLogsChunked,
  getTransfer,
  isTerminal,
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
  /** The last read failed and there is nothing to show yet. See the catch below. */
  unreadable: boolean;
  reload: () => Promise<void>;
} {
  const [rows, setRows] = useState<IncomingTransfer[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const inFlight = useRef(false);
  /**
   * Scan cursor, the transfers found so far, and the ones that can never change
   * again.
   *
   * A poll used to walk the whole lookback: 200k blocks in 10k windows is twenty
   * `eth_getLogs` every fifteen seconds, forever, for a set of blocks that had
   * already been read twenty times. The first pass still looks back far enough to
   * cover the life of a wallet; every pass after it covers only the blocks since
   * the last one. Statuses do change, so open transfers are re-read each time --
   * but CLAIMED, CANCELLED and RECLAIMED are ends, and an ended transfer is read
   * once and then remembered.
   */
  const cursor = useRef<bigint | null>(null);
  const found = useRef<Map<string, bigint>>(new Map());
  const settled = useRef<Map<string, IncomingTransfer>>(new Map());

  const reload = useCallback(async () => {
    if (!session) {
      setRows(null);
      setUnreadable(false);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    const client = getPublicClient();
    const me = session.address.toLowerCase();
    try {
      const latest = await client.getBlockNumber();
      const fromBlock = cursor.current ?? (latest > LOOKBACK ? latest - LOOKBACK : 0n);
      if (fromBlock <= latest) {
        const logs = await getLogsChunked<{ to?: Address; transferId?: bigint }>(client, {
          address: CTRL_ARCZ_ADDRESS,
          abi: ctrlArcZAbi,
          eventName: 'TransferCreated',
          args: { to: session.address as Address },
          fromBlock,
          toBlock: latest,
        });
        for (const l of logs) {
          if (l.args.to?.toLowerCase() !== me) continue;
          const id = l.args.transferId?.toString();
          if (id && !found.current.has(id))
            found.current.set(id, (l as { blockNumber?: bigint }).blockNumber ?? 0n);
        }
      }
      cursor.current = latest + 1n;

      const resolved = await Promise.all(
        [...found.current].map(async ([id, block]) => {
          const done = settled.current.get(id);
          if (done) return done;
          const [transfer, at] = await Promise.all([
            getTransfer({ publicClient: client }, BigInt(id)).catch(() => null),
            blockTime(client, block),
          ]);
          if (!transfer) return null;
          const row = { transferId: BigInt(id), transfer, block, at };
          if (isTerminal(transfer.status)) settled.current.set(id, row);
          return row;
        }),
      );
      setRows(
        resolved
          .filter((r): r is IncomingTransfer => r !== null)
          .sort((a, b) => Number(b.transferId - a.transferId)),
      );
      setUnreadable(false);
    } catch {
      // An unreachable chain is not an empty history. Writing `[]` here told a
      // wallet with five transfers in it that nothing had ever been sent to it,
      // which is the one thing this screen must never get wrong. Keep whatever was
      // last read, and if nothing has been read yet, say so.
      setUnreadable(true);
    } finally {
      inFlight.current = false;
    }
  }, [session]);

  // A different wallet has a different inbox: drop the cursor and everything
  // remembered so the next poll rescans from the lookback for the new address.
  useEffect(() => {
    cursor.current = null;
    found.current = new Map();
    settled.current = new Map();
    setRows(null);
  }, [session?.address]);

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

  return { rows, unreadable: unreadable && rows === null, reload };
}
