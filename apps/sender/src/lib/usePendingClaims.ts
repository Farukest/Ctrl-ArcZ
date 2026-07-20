import { useCallback, useEffect, useState } from 'react';
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

  const reload = useCallback(async () => {
    if (!session) {
      setPending(null);
      return;
    }
    const client = getPublicClient();
    const me = session.address.toLowerCase();
    try {
      const logs = await getLogsChunked<{ to?: Address; transferId?: bigint }>(client, {
        address: CTRL_ARCZ_ADDRESS,
        abi: ctrlArcZAbi,
        eventName: 'TransferCreated',
        args: { to: session.address as Address },
      });
      const ids = [
        ...new Set(
          logs
            .filter((l) => l.args.to?.toLowerCase() === me)
            .map((l) => l.args.transferId?.toString())
            .filter((id): id is string => Boolean(id)),
        ),
      ];
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

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 8000);
    return () => clearInterval(timer);
  }, [reload]);

  return { pending, reload };
}
