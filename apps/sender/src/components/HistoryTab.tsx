import { useEffect, useMemo, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { getCleanHistory, type CleanHistory } from '@ctrl-arcz/sdk';
import { type Session } from '@ctrl-arcz/demo-kit';
import {
  Badge,
  Button,
  Card,
  Pagination,
  Skeleton,
  paginate,
  useT,
  short,
} from '@ctrl-arcz/demo-kit/ui';

const PAGE_SIZE = 6;

export function HistoryTab({ session }: { session: Session }) {
  const t = useT();
  const [history, setHistory] = useState<CleanHistory | null>(null);
  const [showSpam, setShowSpam] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    getCleanHistory(session.address as Address)
      .then(setHistory)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [session.address]);

  const entries = history?.entries ?? [];
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  // Clamp so switching to an account with fewer entries can never strand the view
  // on an out-of-range page (blank list, no pagination control to get back).
  const safePage = Math.min(page, pageCount - 1);
  const pageEntries = useMemo(() => paginate(entries, safePage, PAGE_SIZE), [entries, safePage]);

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

      {entries.length === 0 ? (
        <p className="muted">{t('history.empty')}</p>
      ) : (
        <>
          {pageEntries.map((e) => (
            <div className="trow trow--compact" key={e.txHash}>
              <div className="row-between">
                <div className="hrow__party">
                  <span className={`hrow__dir hrow__dir--${e.direction}`}>
                    {e.direction === 'in' ? '↓' : '↑'}
                  </span>
                  <span className="mono">{short(e.counterparty)}</span>
                </div>
                <div className="trow__idline">
                  <span className="trow__amount">{formatUnits(e.amount, e.decimals)}</span>
                  <span className="trow__unit">{e.tokenSymbol}</span>
                </div>
              </div>
            </div>
          ))}
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </>
      )}

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
              <div
                className="trow trow--compact"
                key={e.txHash}
                style={{ opacity: 0.6, marginTop: 8 }}
              >
                <div className="row-between">
                  <span className="mono">{short(e.counterparty)}</span>
                  <Badge>
                    {e.reason === 'ZERO_VALUE' ? t('history.zeroValue') : t('history.unknownToken')}
                  </Badge>
                </div>
              </div>
            ))}
        </>
      )}
    </Card>
  );
}
