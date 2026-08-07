import { useEffect, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import {
  explorerTxUrl,
  getCleanHistory,
  type CleanHistory,
  type HistoryEntry,
} from '@ctrl-arcz/sdk';
import { type Session } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  HistoryList,
  HistoryRow,
  Address as AddressChip,
  Skeleton,
  useT,
} from '@ctrl-arcz/demo-kit/ui';

/** Everything a row can be matched on: who, how much, which token, which tx. */
function entryHaystack(e: HistoryEntry): string {
  return `${e.counterparty} ${formatUnits(e.amount, e.decimals)} ${e.tokenSymbol} ${e.txHash} ${e.direction}`;
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

const PAGE_SIZE = 6;

export function HistoryTab({ session }: { session: Session }) {
  const t = useT();
  const [history, setHistory] = useState<CleanHistory | null>(null);
  const [showSpam, setShowSpam] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCleanHistory(session.address as Address)
      .then(setHistory)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [session.address]);

  const entries = history?.entries ?? [];

  if (error)
    return (
      <Card>
        <div className="err-text">{error}</div>
      </Card>
    );
  if (!history)
    return (
      <Card>
        <Skeleton height={48} />
        <div style={{ height: 8 }} />
        <Skeleton height={48} />
      </Card>
    );

  return (
    <Card data-testid="history">
      <p className="muted">{t('history.note')}</p>

      <HistoryList
        items={entries}
        data-testid="history-list"
        searchText={entryHaystack}
        timestamp={(e) => e.timestamp.getTime()}
        rowKey={(e) => e.txHash}
        searchPlaceholder={t('history.search')}
        emptyText={t('history.empty')}
        noMatchText={t('history.noMatch')}
        pageSize={PAGE_SIZE}
        renderRow={(e) => (
          <HistoryRow data-testid="history-row">
            <HistoryRow.Head
              lead={
                <>
                  <span className={`hrow__dir hrow__dir--${e.direction}`}>
                    {e.direction === 'in' ? '↓' : '↑'}
                  </span>
                  <AddressChip address={e.counterparty} />
                </>
              }
              amount={`${formatUnits(e.amount, e.decimals)} ${e.tokenSymbol}`}
              time={relativeTime(e.timestamp.getTime())}
            />
            {/* The transaction was not shown at all, so a row you wanted to look up
                or forward gave you nothing to look up or forward. */}
            <HistoryRow.Steps
              steps={[
                {
                  label: e.direction === 'in' ? t('history.received') : t('history.sent'),
                  txHash: e.txHash,
                  explorerUrl: explorerTxUrl(e.txHash),
                },
              ]}
            />
          </HistoryRow>
        )}
      />

      {history.filtered.length > 0 && (
        <>
          <hr className="rule" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSpam((s) => !s)}
            data-testid="toggle-spam"
          >
            {showSpam
              ? t('history.hideSpam')
              : t('history.showSpam', { count: history.filtered.length })}
          </Button>
          {showSpam &&
            history.filtered.map((e) => (
              <div key={e.txHash} style={{ opacity: 0.6, marginTop: 8 }}>
                <HistoryRow data-testid="history-spam-row">
                  <HistoryRow.Head
                    lead={<AddressChip address={e.counterparty} />}
                    status={{
                      tone: 'warn',
                      label:
                        e.reason === 'ZERO_VALUE'
                          ? t('history.zeroValue')
                          : t('history.unknownToken'),
                    }}
                    time={relativeTime(e.timestamp.getTime())}
                  />
                  <HistoryRow.Steps
                    steps={[
                      {
                        label: t('history.filteredOut'),
                        txHash: e.txHash,
                        explorerUrl: explorerTxUrl(e.txHash),
                      },
                    ]}
                  />
                </HistoryRow>
              </div>
            ))}
        </>
      )}
    </Card>
  );
}
