import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import {
  cancel,
  explorerTxUrl,
  getTransfer,
  TransferUnavailableError,
  type ProtectedTransfer,
} from '@ctrl-arcz/sdk';
import { type Session } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  HistoryList,
  HistoryRow,
  Address as AddressChip,
  Copyable,
  type RowTone,
  Skeleton,
  useSubmitGuard,
  useT,
  useToast,
} from '@ctrl-arcz/demo-kit/ui';
import { loadTransfers, type StoredTransfer } from '../store.js';

interface Row {
  stored: StoredTransfer;
  chain: ProtectedTransfer | null;
}

const PAGE_SIZE = 5;

/** One lowercased haystack for searching a transfer row. */
function transferHaystack(r: Row): string {
  return [
    `#${r.stored.transferId}`,
    r.stored.amount,
    'usdc',
    r.stored.to,
    r.stored.secret,
    r.chain?.status ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

/** Chain status to the row's four tones, so every history reads the same way. */
function statusTone(status: string): RowTone {
  if (status === 'CLAIMED') return 'ok';
  if (status === 'CANCELLED' || status === 'EXPIRED') return 'err';
  if (status === 'LOCKED') return 'warn';
  return 'idle';
}

/** Rows are history, so time is relative: "3m" reads faster than a timestamp. */
function relativeTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function TransfersTab({ session, onChange }: { session: Session; onChange: () => void }) {
  const toast = useToast();
  const t = useT();
  const guard = useSubmitGuard();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const stored = loadTransfers(session.address as Address);
    const resolved = await Promise.all(
      stored.map(async (s) => ({
        stored: s,
        chain: await getTransfer(session.clients, BigInt(s.transferId)).catch(() => null),
      })),
    );
    setRows(resolved);
  }, [session]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  const filtered = rows ?? [];

  async function handleCancel(id: string) {
    setBusy(id);
    try {
      await cancel(session.clients, BigInt(id));
      toast.push(t('active.cancelledToast', { id }), 'success');
      await load();
      onChange();
    } catch (e) {
      if (e instanceof TransferUnavailableError) {
        toast.push(t(`transfer.unavailable.${e.reason}` as never), 'error');
      } else {
        toast.push(e instanceof Error ? e.message : t('active.cancelFailed'), 'error');
      }
      await load(); // resync the row's on-chain status after a failed cancel
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) {
    return (
      <Card>
        <Skeleton height={64} />
        <div style={{ height: 10 }} />
        <Skeleton height={64} />
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <p className="muted">{t('active.empty')}</p>
      </Card>
    );
  }

  return (
    <Card data-testid="transfers-list">
      <HistoryList
        items={filtered}
        data-testid="transfers-history"
        searchText={transferHaystack}
        timestamp={(r) => r.stored.createdAt}
        rowKey={(r) => r.stored.transferId}
        searchPlaceholder={t('active.search')}
        emptyText={t('active.empty')}
        noMatchText={t('active.noMatch')}
        pageSize={PAGE_SIZE}
        renderRow={({ stored, chain }) => {
          const status = chain?.status ?? 'NONE';
          const canCancel = status === 'PENDING' || status === 'LOCKED';
          return (
            <HistoryRow data-testid={`transfer-${stored.transferId}`}>
              <HistoryRow.Head
                lead={
                  <>
                    {/* Plain text, not a `Copyable`. That component shortens a long
                        value and puts the whole of it on the clipboard, which is
                        the right trade for an address or a hash and the wrong one
                        for a two-character id: nothing is hidden, and clicking
                        takes longer than reading it. The row already carries the
                        transaction hash, which is the thing anyone actually pastes
                        into an explorer. */}
                    <span className="hrow__id mono">#{stored.transferId}</span>
                    <span className="hrow__arrow" aria-hidden>
                      &rarr;
                    </span>
                    <AddressChip address={stored.to} />
                  </>
                }
                amount={`${stored.amount} USDC`}
                status={{ tone: statusTone(status), label: status }}
                time={relativeTime(stored.createdAt)}
              />
              {/* The claim code is the one thing the recipient cannot do without,
                  and the one thing a sender has to get out of this screen and into a
                  message, so it is copyable in full rather than shortened. It is
                  held in memory only, so after a reload there is nothing to show and
                  an empty row would be worse than none. */}
              {stored.secret && (
                <HistoryRow.Facts>
                  <HistoryRow.Fact label={t('active.code')}>
                    <Copyable value={stored.secret} />
                  </HistoryRow.Fact>
                </HistoryRow.Facts>
              )}
              <HistoryRow.Steps
                steps={[
                  {
                    label: t('active.stepSent'),
                    txHash: stored.txHash,
                    explorerUrl: explorerTxUrl(stored.txHash),
                  },
                ]}
              />
              {canCancel && (
                <HistoryRow.Actions>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy === stored.transferId}
                    disabled={Boolean(busy)}
                    onClick={() => void guard(() => handleCancel(stored.transferId))}
                    data-testid={`cancel-${stored.transferId}`}
                  >
                    {busy === stored.transferId ? t('active.cancelling') : t('active.cancel')}
                  </Button>
                </HistoryRow.Actions>
              )}
            </HistoryRow>
          );
        }}
      />
    </Card>
  );
}
