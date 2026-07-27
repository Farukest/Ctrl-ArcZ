import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import {
  ctrlArcZAbi,
  CTRL_ARCZ_ADDRESS,
  getLogsChunked,
  getTransfer,
  type ProtectedTransfer,
} from '@ctrl-arcz/sdk';

export interface PendingClaim {
  transferId: bigint;
  transfer: ProtectedTransfer;
}

/**
 * Bound the first scan, then only walk forward. Scanning from the deploy block on
 * every poll meant ~257 chunked eth_getLogs every 8 seconds (2.5M blocks in 10k
 * windows), which rate limited the RPC into 429s app-wide. The first pass looks back
 * this far, and each later pass covers only the blocks since the last one.
 */
const FIRST_SCAN_LOOKBACK = 120_000n;

/**
 * Incoming protected transfers addressed to the connected wallet that are still
 * PENDING (claimable). Runs app-wide (independent of which mode is showing) so the
 * "Receive" side of the mode switch can badge a waiting claim even while the user is
 * on the Send side. Polls every 8s.
 */
export function usePendingClaims(session: Session | null): {
  pending: PendingClaim[] | null;
  reload: () => Promise<void>;
} {
  const [pending, setPending] = useState<PendingClaim[] | null>(null);
  // Scan cursor and the ids found so far, so a poll only covers new blocks.
  const cursor = useRef<bigint | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!session) {
      setPending(null);
      return;
    }
    const client = getPublicClient();
    const me = session.address.toLowerCase();
    try {
      const latest = await client.getBlockNumber();
      const from =
        cursor.current ??
        (latest > FIRST_SCAN_LOOKBACK ? latest - FIRST_SCAN_LOOKBACK : 0n);
      if (from <= latest) {
        const logs = await getLogsChunked<{ to?: Address; transferId?: bigint }>(client, {
          address: CTRL_ARCZ_ADDRESS,
          abi: ctrlArcZAbi,
          eventName: 'TransferCreated',
          args: { to: session.address as Address },
          fromBlock: from,
          toBlock: latest,
        });
        for (const l of logs) {
          if (l.args.to?.toLowerCase() !== me) continue;
          const id = l.args.transferId?.toString();
          if (id) seen.current.add(id);
        }
      }
      cursor.current = latest + 1n;
      const ids = [...seen.current];
      const resolved = await Promise.all(
        ids.map(async (id) => ({
          transferId: BigInt(id),
          transfer: await getTransfer({ publicClient: client }, BigInt(id)).catch(() => null),
        })),
      );
      setPending(
        resolved
          .filter((r): r is PendingClaim => r.transfer !== null && r.transfer.status === 'PENDING')
          .sort((a, b) => Number(b.transferId - a.transferId)),
      );
    } catch {
      setPending([]);
    }
  }, [session]);

  // A different wallet has different incoming transfers: drop the cursor and the
  // accumulated ids so the next poll rescans from the lookback for the new address.
  useEffect(() => {
    cursor.current = null;
    seen.current = new Set();
  }, [session?.address]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 8000);
    return () => clearInterval(timer);
  }, [reload]);

  return { pending, reload };
}
