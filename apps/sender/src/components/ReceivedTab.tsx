import { useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import type { Session } from '@ctrl-arcz/demo-kit';
import { isReturnable, reclaimExpired, statusBucket, type StatusBucket } from '@ctrl-arcz/sdk';
import {
  Button,
  Card,
  HistoryList,
  HistoryRow,
  Address as AddressChip,
  Skeleton,
  receivedHaystack,
  relativeTime,
  statusTone,
  useT,
  useToast,
} from '@ctrl-arcz/demo-kit/ui';
import { useIncoming } from '../lib/useIncoming.js';

const PAGE_SIZE = 5;

type Filter = 'all' | StatusBucket;

/**
 * The receiving side's history: every protected transfer ever addressed to this
 * wallet, not just the claimable ones. Read from the chain, so it is the same on any
 * device and survives clearing the browser.
 */
export function ReceivedTab({ session }: { session: Session }) {
  const t = useT();
  const toast = useToast();
  const { rows, unreadable } = useIncoming(session);
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
      c[statusBucket(r.transfer.status)]++;
    }
    return c;
  }, [rows]);

  const filtered = useMemo(
    () =>
      (rows ?? []).filter((r) => filter === 'all' || statusBucket(r.transfer.status) === filter),
    [rows, filter],
  );

  if (rows === null) {
    return (
      <Card title={t('received.title')}>
        {/* Nothing read yet. A failed read is not an empty history, and saying
            "nothing has been sent to you" on a dropped connection is the one
            mistake this screen cannot afford. */}
        {unreadable ? (
          <p className="muted">{t('received.unreadable')}</p>
        ) : (
          <Skeleton height={72} />
        )}
      </Card>
    );
  }

  return (
    <Card title={t('received.title')} data-testid="received-list">
      <HistoryList
        items={filtered}
        data-testid="received-history"
        resetKey={filter}
        // The chips carry counts, which a dropdown cannot, so they stay this
        // screen's own. Where they sit is not: under the search line, like every
        // other list that has them.
        filters={
          <div className="sub-chips" data-testid="received-filters">
            {(['all', 'pending', 'claimed', 'cancelled', 'expired'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`sub-chip ${filter === f ? 'sub-chip--on' : ''}`}
                onClick={() => setFilter(f)}
                data-testid={`received-chip-${f}`}
              >
                {t(`received.filter.${f}` as never)}{' '}
                <span className="sub-chip__n">{counts[f]}</span>
              </button>
            ))}
          </div>
        }
        searchText={receivedHaystack}
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
                  {/* See TransfersTab: a two-character id is read, not copied. */}
                  <span className="hrow__id mono">#{transferId.toString()}</span>
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
