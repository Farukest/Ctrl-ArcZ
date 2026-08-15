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
  ListSkeleton,
  relativeTime,
  useT,
} from '@ctrl-arcz/demo-kit/ui';

/**
 * Everything a row can be matched on: who, how much, which token, which tx.
 * `kind` and `method` are in here because a bridge arrival no longer shows an
 * address, and a row you cannot search for is a row you cannot find: typing
 * "bridge" or "gateway" has to reach the rows that say it.
 */
function entryHaystack(e: HistoryEntry): string {
  const bridge = e.kind === 'mint' ? 'bridge bridged in mint' : '';
  return [
    e.counterparty,
    formatUnits(e.amount, e.decimals),
    e.tokenSymbol,
    e.txHash,
    e.direction,
    e.kind,
    e.method ?? '',
    bridge,
  ].join(' ');
}

const PAGE_SIZE = 6;

/**
 * What to put where the counterparty goes.
 *
 * A mint has no sender, so the indexer hands back 0x0000...0000 and the row read
 * "received 0.2 USDC from 0x0000...0000": money from nobody. On Arc that row is
 * almost always the holder's own funds landing from the Bridge tab two clicks away,
 * so it names the route it came in on. `method` comes from the explorer and is
 * untrusted, which is fine here: it only picks between two labels, and an
 * unrecognised value falls back to the plain one.
 */
function Party({ entry }: { entry: HistoryEntry }) {
  const t = useT();
  if (entry.kind === 'transfer') return <AddressChip address={entry.counterparty} />;
  if (entry.kind === 'burn') return <span className="hrow__party">{t('history.burned')}</span>;
  const label =
    entry.method === 'receiveMessage'
      ? t('history.bridgedInCctp')
      : entry.method === 'gatewayMint'
        ? t('history.bridgedInGateway')
        : t('history.bridgedIn');
  return <span className="hrow__party">{label}</span>;
}

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
  // Reserves the size this card is about to be. Two 48px bars stood in for a 951px
  // list, so the page grew 389px the moment the read landed.
  if (!history)
    return (
      <Card>
        <p className="muted">{t('history.note')}</p>
        <ListSkeleton rows={PAGE_SIZE} rowHeight={105} reserveId="history" />
      </Card>
    );

  return (
    <Card data-testid="history">
      <p className="muted">{t('history.note')}</p>

      <HistoryList
        items={entries}
        data-testid="history-list"
        reserveId="history"
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
                  <Party entry={e} />
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
                    lead={<Party entry={e} />}
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
