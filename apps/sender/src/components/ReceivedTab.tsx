import { useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import { explorerAddressUrl, reclaimExpired, type TransferStatus } from '@ctrl-arcz/sdk';
import type { Session } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  IconExternal,
  PagedList,
  Pagination,
  SearchField,
  Skeleton,
  StatusPill,
  paginate,
  short,
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

export function ReceivedTab({ session }: { session: Session }) {
  const t = useT();
  const toast = useToast();
  const { rows } = useIncoming(session);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? [])
      .filter((r) => filter === 'all' || bucket(r.transfer.status) === filter)
      .filter((r) => !q || haystack(r).includes(q));
  }, [rows, filter, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(() => paginate(filtered, safePage, PAGE_SIZE), [filtered, safePage]);

  if (rows === null) {
    return (
      <Card title={t('received.title')}>
        <Skeleton height={72} />
      </Card>
    );
  }

  return (
    <Card title={t('received.title')} data-testid="received-list">
      <SearchField
        value={query}
        onChange={(v) => {
          setQuery(v);
          setPage(0);
        }}
        placeholder={t('received.search')}
        ariaLabel={t('received.search')}
        data-testid="received-search"
      />

      <div className="sub-chips" data-testid="received-filters">
        {(['all', 'pending', 'claimed', 'cancelled', 'expired'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`sub-chip ${filter === f ? 'sub-chip--on' : ''}`}
            onClick={() => {
              setFilter(f);
              setPage(0);
            }}
            data-testid={`received-chip-${f}`}
          >
            {t(`received.filter.${f}` as never)} <span className="sub-chip__n">{counts[f]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="muted" style={{ marginTop: 14 }}>
          {rows.length === 0 ? t('received.empty') : t('received.noMatch')}
        </p>
      ) : (
        <PagedList resetKey={`${query}:${filter}`} reserve={safePage < pageCount - 1}>
          <div style={{ marginTop: 14 }}>
            {pageRows.map(({ transferId, transfer }) => (
              <div
                className="trow trow--compact"
                key={transferId.toString()}
                data-testid={`received-${transferId.toString()}`}
              >
                <div className="trow__top">
                  <div className="trow__idline">
                    <span className="trow__id">#{transferId.toString()}</span>
                    <span className="trow__sep">·</span>
                    <span className="trow__amount">{formatUnits(transfer.amount, 6)}</span>
                    <span className="trow__unit">USDC</span>
                  </div>
                  <StatusPill status={transfer.status} />
                </div>
                <div className="trow__to">
                  ←{' '}
                  <a href={explorerAddressUrl(transfer.sender)} target="_blank" rel="noreferrer">
                    {short(transfer.sender)} <IconExternal width={12} height={12} />
                  </a>
                </div>
                {isReturnable(transfer) && (
                  <div style={{ marginTop: 8 }}>
                    <p className="muted" style={{ marginBottom: 6 }}>
                      {t('received.expiredHint')}
                    </p>
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
                  </div>
                )}
              </div>
            ))}
          </div>
        </PagedList>
      )}

      {filtered.length > 0 && (
        <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
      )}
    </Card>
  );
}
