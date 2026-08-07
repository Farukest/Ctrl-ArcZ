import { useMemo, useState, type ReactNode } from 'react';
import { PagedList, Pagination, SearchField, Select, paginate } from './components.js';
import { useT } from '../i18n/context.js';

/**
 * Every list of past things, in one place.
 *
 * Five screens had grown their own copy of the same four controls: a search box, a
 * status filter, pagination, and a page-reset whenever either changed. They drifted,
 * as copies do, and none of them had gained a way to narrow by date even though the
 * only question anyone asks of a history is "what happened around then". Adding it
 * five times was the wrong shape of work, so the shape changed instead.
 *
 * Rows arrive grouped under the day they happened on, because a flat list of
 * timestamps makes the reader do the grouping in their head. Today and yesterday are
 * named rather than dated: those are the two a person is usually looking for, and a
 * date is a worse answer to "did this go out today" than the word today.
 */

export type DateWindow = 'all' | 'today' | 'week' | 'month';

const WINDOW_MS: Record<Exclude<DateWindow, 'all'>, number> = {
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/** Midnight-based day index, so "yesterday" means the calendar day, not 24 hours. */
function dayIndex(ts: number): number {
  const d = new Date(ts);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
}

export interface HistoryListProps<T> {
  items: readonly T[];
  /** Everything a row can be matched on, already lowercased by the caller if it likes. */
  searchText: (item: T) => string;
  /** When the row happened, in epoch ms. Drives both the filter and the grouping. */
  timestamp: (item: T) => number;
  renderRow: (item: T) => ReactNode;
  /** A stable key per row. */
  rowKey: (item: T) => string;
  searchPlaceholder: string;
  /** Optional extra filter, rendered beside the date one. */
  filter?: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
    ariaLabel: string;
  };
  emptyText: string;
  noMatchText: string;
  pageSize?: number;
  'data-testid'?: string;
}

export function HistoryList<T>({
  items,
  searchText,
  timestamp,
  renderRow,
  rowKey,
  searchPlaceholder,
  filter,
  emptyText,
  noMatchText,
  pageSize = 5,
  ...rest
}: HistoryListProps<T>) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [window, setWindow] = useState<DateWindow>('all');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cutoff = window === 'all' ? 0 : Date.now() - WINDOW_MS[window];
    return items.filter(
      (item) => (!q || searchText(item).toLowerCase().includes(q)) && timestamp(item) >= cutoff,
    );
  }, [items, query, window, searchText, timestamp]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const rows = paginate(filtered, safePage, pageSize);

  /**
   * Group the rows on this page only. Grouping the whole set and then paginating
   * would put a heading on one page and its rows on the next.
   */
  const groups = useMemo(() => {
    const today = dayIndex(Date.now());
    const out: { label: string; items: T[] }[] = [];
    for (const item of rows) {
      const day = dayIndex(timestamp(item));
      const label =
        day === today
          ? t('history.today')
          : day === today - 1
            ? t('history.yesterday')
            : new Date(timestamp(item)).toLocaleDateString();
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item);
      else out.push({ label, items: [item] });
    }
    return out;
  }, [rows, timestamp, t]);

  const reset = () => setPage(0);

  if (items.length === 0) return <p className="muted">{emptyText}</p>;

  return (
    <div {...rest}>
      <div className="hist-controls">
        <SearchField
          value={query}
          onChange={(v) => {
            setQuery(v);
            reset();
          }}
          placeholder={searchPlaceholder}
          ariaLabel={searchPlaceholder}
          data-testid="history-search"
        />
        <Select
          value={window}
          options={[
            { value: 'all', label: t('history.anyTime') },
            { value: 'today', label: t('history.today') },
            { value: 'week', label: t('history.week') },
            { value: 'month', label: t('history.month') },
          ]}
          onChange={(v) => {
            setWindow(v as DateWindow);
            reset();
          }}
          ariaLabel={t('history.dateFilter')}
        />
        {filter && (
          <Select
            value={filter.value}
            options={filter.options}
            onChange={(v) => {
              filter.onChange(v);
              reset();
            }}
            ariaLabel={filter.ariaLabel}
          />
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="muted" style={{ marginTop: 14 }}>
          {noMatchText}
        </p>
      ) : (
        <>
          <PagedList resetKey={`${query}:${window}`} reserve={safePage < pageCount - 1}>
            <div style={{ marginTop: 14 }}>
              {groups.map((group) => (
                <div key={group.label} className="hist-group">
                  <div className="hist-group__day">{group.label}</div>
                  {group.items.map((item) => (
                    <div key={rowKey(item)}>{renderRow(item)}</div>
                  ))}
                </div>
              ))}
            </div>
          </PagedList>
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </div>
  );
}
