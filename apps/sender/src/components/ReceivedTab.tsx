import { useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import type { Session } from '@ctrl-arcz/demo-kit';
import { reclaimExpired, type TransferStatus } from '@ctrl-arcz/sdk';
import {
  Button,
  Card,
  HistoryList,
  HistoryRow,
  Address as AddressChip,
  Copyable,
  type RowTone,
  Skeleton,
  useT,
  useToast,
} from '@ctrl-arcz/demo-kit/ui';
import { useIncoming, type IncomingTransfer } from '../lib/useIncoming.js';

const PAGE_SIZE = 5;

type Filter = 'all' | 'pending' | 'claimed' | 'cancelled' | 'expired';

/** Which filter a chain status belongs under. LOCKED (five wrong codes) sits with
 *  pending: the money is still there and the sender can still cancel it. */
function bucket(status: TransferStatus): Exclude<Filter, 'all'> {
  if (status === 'CLAIMED') return 'claimed';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'RECLAIMED') return 'expired';
  return 'pending';
}

/** Everything searchable about a row, so one box matches an amount, a sender or an id. */
function haystack(r: IncomingTransfer): string {
  return [
    r.transferId.toString(),
    formatUnits(r.transfer.amount, 6),
    'usdc',
    r.transfer.sender,
    r.transfer.status,
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * The receiving side's history: every protected transfer ever addressed to this
 * wallet, not just the claimable ones. Read from the chain, so it is the same on any
 * device and survives clearing the browser.
 */
/**
 * A transfer whose window has lapsed while the money is still in the contract.
 *
 * The chain has no such status: it stays PENDING until somebody calls
 * `reclaimExpired`, so this is the one state the recipient can see and act on
 * that no status pill names.
 */
function isReturnable(transfer: IncomingTransfer['transfer']): boolean {
  const open = transfer.status === 'PENDING' || transfer.status === 'LOCKED';
  return open && Date.now() > transfer.deadline.getTime();
}

/** Same four tones every history uses, so the lists read alike. */
function statusTone(status: string): RowTone {
  if (status === 'CLAIMED') return 'ok';
  if (status === 'CANCELLED' || status === 'EXPIRED') return 'err';
  if (status === 'LOCKED') return 'warn';
  return 'idle';
}

function relativeTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function ReceivedTab({ session }: { session: Session }) {
  const t = useT();
  const toast = useToast();
  const { rows } = useIncoming(session);
  const [filter, setFilter] = useState<Filter>('all');
  const [returning, setReturning] = useState<string | null>(null);

  /**
   * Send an expired transfer back to whoever sent it.
   *
   * `cancel` is the sender's alone, and rightly: unclaimed money is theirs. But
   * that left the recipient of a payment they never wanted with nothing to do
   * about it, which is the wrong side of this product to be helpless on. The
   * contract already allows this -- `reclaimExpired` is permissionless and pays
   * `t.sender` and nobody else -- so the recipient could always do it and simply
   * had no button. Handing the attacker in a poisoning attack this same button
   * costs nothing either: the only thing it can do is give the money back.
   */
  async function returnToSender(transferId: bigint) {
    setReturning(transferId.toString());
    try {
      await reclaimExpired(session.clients, transferId);
      toast.push(t('received.returned'), 'success');
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setReturning(null);
    }
  }

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, pending: 0, claimed: 0, cancelled: 0, expired: 0 };
    for (const r of rows ?? []) {
      c.all++;
      c[bucket(r.transfer.status)]++;
    }
    return c;
  }, [rows]);

  const filtered = useMemo(
    () => (rows ?? []).filter((r) => filter === 'all' || bucket(r.transfer.status) === filter),
    [rows, filter],
  );

  if (rows === null) {
    return (
      <Card title={t('received.title')}>
        <Skeleton height={72} />
      </Card>
    );
  }

  return (
    <Card title={t('received.title')} data-testid="received-list">
      {/* The status chips stay: they carry counts, which a dropdown cannot, and on
          this screen "what can I still claim" is the first question. Search, date
          and paging are the shared list's. */}
      <div className="sub-chips" data-testid="received-filters">
        {(['all', 'pending', 'claimed', 'cancelled', 'expired'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`sub-chip ${filter === f ? 'sub-chip--on' : ''}`}
            onClick={() => setFilter(f)}
            data-testid={`received-chip-${f}`}
          >
            {t(`received.filter.${f}` as never)} <span className="sub-chip__n">{counts[f]}</span>
          </button>
        ))}
      </div>

      <HistoryList
        items={filtered}
        data-testid="received-history"
        searchText={haystack}
        timestamp={(r) => r.at}
        rowKey={(r) => r.transferId.toString()}
        searchPlaceholder={t('received.search')}
        emptyText={t('received.empty')}
        noMatchText={t('received.noMatch')}
        pageSize={PAGE_SIZE}
        renderRow={({ transferId, transfer, at }) => (
          <HistoryRow data-testid={`received-${transferId.toString()}`}>
            <HistoryRow.Head
              lead={
                <>
                  <Copyable value={transferId.toString()} display={`#${transferId.toString()}`} />
                  <span className="hrow__arrow" aria-hidden>
                    &larr;
                  </span>
                  <AddressChip address={transfer.sender} />
                </>
              }
              amount={`${formatUnits(transfer.amount, 6)} USDC`}
              status={{ tone: statusTone(transfer.status), label: transfer.status }}
              time={relativeTime(at)}
            />
            {isReturnable(transfer) && (
              <>
                <HistoryRow.Facts>
                  <HistoryRow.Fact label={t('received.expiredLabel')}>
                    {t('received.expiredHint')}
                  </HistoryRow.Fact>
                </HistoryRow.Facts>
                <HistoryRow.Actions>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={returning === transferId.toString()}
                    disabled={returning !== null}
                    onClick={() => void returnToSender(transferId)}
                    data-testid={`return-${transferId.toString()}`}
                  >
                    {t('received.returnToSender')}
                  </Button>
                </HistoryRow.Actions>
              </>
            )}
          </HistoryRow>
        )}
      />
    </Card>
  );
}
