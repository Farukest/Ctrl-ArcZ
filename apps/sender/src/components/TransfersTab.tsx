import { useCallback, useEffect, useMemo, useState } from 'react';
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
  CopyButton,
  PagedList,
  Pagination,
  SearchField,
  Skeleton,
  StatusPill,
  paginate,
  useSubmitGuard,
  useT,
  useToast,
  short,
} from '@ctrl-arcz/demo-kit/ui';
import { IconExternal } from '@ctrl-arcz/demo-kit/ui';
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
    r.stored.code,
    r.chain?.status ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

export function TransfersTab({ session, onChange }: { session: Session; onChange: () => void }) {
  const toast = useToast();
  const t = useT();
  const guard = useSubmitGuard();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');

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

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return q ? rows.filter((r) => transferHaystack(r).includes(q)) : rows;
  }, [rows, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(() => paginate(filtered, safePage, PAGE_SIZE), [filtered, safePage]);

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
      <SearchField
        value={query}
        onChange={(v) => {
          setQuery(v);
          setPage(0);
        }}
        placeholder={t('active.search')}
        ariaLabel={t('active.search')}
        data-testid="transfers-search"
      />
      {filtered.length === 0 ? (
        <p className="muted" style={{ marginTop: 14 }}>
          {t('active.noMatch')}
        </p>
      ) : (
        <PagedList resetKey={query}>
          <div style={{ marginTop: 14 }}>
            {pageRows.map(({ stored, chain }) => {
              const status = chain?.status ?? 'NONE';
              const canCancel = status === 'PENDING' || status === 'LOCKED';
              return (
                <div
                  className="trow"
                  key={stored.transferId}
                  data-testid={`transfer-${stored.transferId}`}
                >
                  <div className="trow__top">
                    <div className="trow__idline">
                      <span className="trow__id">#{stored.transferId}</span>
                      <span className="trow__sep">·</span>
                      <span className="trow__amount">{stored.amount}</span>
                      <span className="trow__unit">USDC</span>
                    </div>
                    <StatusPill status={status} />
                  </div>
                  <div className="trow__to">→ {short(stored.to)}</div>

                  <hr className="rule trow__rule" />

                  <div className="trow__bottom">
                    <div className="trow__code">
                      <span className="trow__code-label">{t('active.code')}</span>
                      <span className="trow__code-value">{stored.code}</span>
                      <CopyButton value={stored.code} />
                    </div>
                    <div className="trow__actions">
                      <a
                        className="linkbtn"
                        href={explorerTxUrl(stored.txHash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        tx <IconExternal width={13} height={13} />
                      </a>
                      {canCancel && (
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
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </PagedList>
      )}
    </Card>
  );
}
