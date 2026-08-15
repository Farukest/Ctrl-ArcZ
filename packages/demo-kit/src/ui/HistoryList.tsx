import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PagedList, Pagination, SearchField, Select, paginate } from './components.js';
import { useRecordHeight } from './reservedHeight.js';
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

export type DateWindow = 'all' | 'today' | 'days3' | 'week' | 'month' | 'custom';

/**
 * Which way the dates point.
 *
 * Everything that has happened is in the past, and "last 7 days" narrows it. A
 * subscription's date is its expiry, which has not happened yet: every backward
 * window contains every future date, so the same control silently stopped
 * filtering anything. The windows are the same lengths, measured the other way.
 */
export type DateDirection = 'past' | 'future';

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_MS: Record<'today' | 'days3' | 'week' | 'month', number> = {
  today: DAY,
  days3: 3 * DAY,
  week: 7 * DAY,
  month: 30 * DAY,
};

/** `2026-08-07` from a date input, as the start and the end of that day. */
function dayStart(v: string): number | null {
  const t = Date.parse(`${v}T00:00:00`);
  return Number.isNaN(t) ? null : t;
}
function dayEnd(v: string): number | null {
  const t = dayStart(v);
  return t == null ? null : t + DAY - 1;
}

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
  /**
   * One more dropdown in the same row, for whatever this screen needs that the
   * others do not: the bridge narrows by engine, the subscriptions list reorders
   * by how soon each one ends. Either way it changes what the first page holds,
   * so it resets the page like the controls beside it.
   */
  control?: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
    ariaLabel: string;
  };
  emptyText: string;
  noMatchText: string;
  pageSize?: number;
  /**
   * Narrowing that happens outside this component, as one string.
   *
   * A screen that keeps its own filter (the received list keeps status chips,
   * because chips can carry counts and a dropdown cannot) filters `items` before
   * handing them over. Without being told, this component cannot know the set
   * changed for a reason rather than because a poll returned, so it kept the page
   * index: narrowing to a single row while on page two, then widening again, left
   * the reader on the last page of a list they had just asked to see all of.
   */
  resetKey?: string;
  /** Which way `timestamp` points. Defaults to `past`, which every history is. */
  dateDirection?: DateDirection;
  /**
   * A screen's own filter row, drawn under the search line.
   *
   * Status chips stay outside this component because they carry counts, which a
   * dropdown cannot. Where they were rendered still mattered though: a screen that
   * put them above the card's search box made the reader narrow before they could
   * look, and put the same two controls in a different order on every list that
   * had them. Passing them here fixes the order in one place.
   */
  filters?: ReactNode;
  /**
   * Ties this list to its loading placeholder, so the placeholder can be exactly
   * as tall as this list settled at last time. See reservedHeight.ts.
   */
  reserveId?: string;
  'data-testid'?: string;
}

export function HistoryList<T>({
  items,
  searchText,
  timestamp,
  renderRow,
  rowKey,
  searchPlaceholder,
  control,
  emptyText,
  noMatchText,
  pageSize = 5,
  resetKey,
  dateDirection = 'past',
  filters,
  reserveId,
  ...rest
}: HistoryListProps<T>) {
  const t = useT();
  const record = useRecordHeight(reserveId);
  const [query, setQuery] = useState('');
  const [window, setWindow] = useState<DateWindow>('all');
  /** Only meaningful while `window` is `custom`; kept so switching back restores it. */
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(0);

  // Whoever narrowed the set outside this component wants its first page, the
  // same as the controls inside it do.
  useEffect(() => setPage(0), [resetKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    // An open-ended custom range is legitimate: "since the third" and "up to the
    // third" are both things people mean, so each end is applied only if given.
    // A preset is bounded on the side the dates are on and open on the other.
    let after = 0;
    let before = Number.MAX_SAFE_INTEGER;
    if (window === 'custom') {
      after = dayStart(fromDate) ?? 0;
      before = dayEnd(toDate) ?? Number.MAX_SAFE_INTEGER;
    } else if (window !== 'all') {
      if (dateDirection === 'future') before = now + WINDOW_MS[window];
      else after = now - WINDOW_MS[window];
    }
    return items.filter((item) => {
      const at = timestamp(item);
      return (!q || searchText(item).toLowerCase().includes(q)) && at >= after && at <= before;
    });
  }, [items, query, window, fromDate, toDate, searchText, timestamp, dateDirection]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const rows = paginate(filtered, safePage, pageSize);

  /**
   * Group the rows on this page only. Grouping the whole set and then paginating
   * would put a heading on one page and its rows on the next.
   */
  const groups = useMemo(() => {
    const today = dayIndex(Date.now());
    // The neighbouring day worth naming is the one the dates are heading towards.
    const near = dateDirection === 'future' ? today + 1 : today - 1;
    const nearLabel = dateDirection === 'future' ? 'history.tomorrow' : 'history.yesterday';
    const out: { label: string; items: T[] }[] = [];
    for (const item of rows) {
      const day = dayIndex(timestamp(item));
      const label =
        day === today
          ? t('history.today')
          : day === near
            ? t(nearLabel as 'history.yesterday')
            : new Date(timestamp(item)).toLocaleDateString();
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item);
      else out.push({ label, items: [item] });
    }
    return out;
  }, [rows, timestamp, t, dateDirection]);

  const reset = () => setPage(0);

  // Recorded too, and this is the case that mattered most: a wallet with nothing
  // received reserved five rows and then collapsed by 763px. An empty list is a
  // height like any other, and next time it is the height that gets reserved.
  if (items.length === 0)
    return (
      <p className="muted" ref={record as React.RefObject<HTMLParagraphElement>}>
        {emptyText}
      </p>
    );

  return (
    <div {...rest} ref={record as React.RefObject<HTMLDivElement>}>
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
          options={
            dateDirection === 'future'
              ? [
                  { value: 'all', label: t('history.anyTime') },
                  { value: 'today', label: t('history.endsToday') },
                  { value: 'days3', label: t('history.endsDays3') },
                  { value: 'week', label: t('history.endsWeek') },
                  { value: 'month', label: t('history.endsMonth') },
                  { value: 'custom', label: t('history.custom') },
                ]
              : [
                  { value: 'all', label: t('history.anyTime') },
                  { value: 'today', label: t('history.today') },
                  { value: 'days3', label: t('history.days3') },
                  { value: 'week', label: t('history.week') },
                  { value: 'month', label: t('history.month') },
                  { value: 'custom', label: t('history.custom') },
                ]
          }
          onChange={(v) => {
            setWindow(v as DateWindow);
            reset();
          }}
          ariaLabel={t('history.dateFilter')}
        />
        {window === 'custom' && (
          <span className="hist-range">
            <input
              type="date"
              className="input input--date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => {
                setFromDate(e.target.value);
                reset();
              }}
              aria-label={t('history.from')}
              data-testid="history-from"
            />
            <span className="hist-range__sep">{'→'}</span>
            <input
              type="date"
              className="input input--date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => {
                setToDate(e.target.value);
                reset();
              }}
              aria-label={t('history.to')}
              data-testid="history-to"
            />
          </span>
        )}
        {control && (
          <Select
            value={control.value}
            options={control.options}
            onChange={(v) => {
              control.onChange(v);
              reset();
            }}
            ariaLabel={control.ariaLabel}
          />
        )}
      </div>

      {filters}

      {filtered.length === 0 ? (
        <p className="muted" style={{ marginTop: 14 }}>
          {noMatchText}
        </p>
      ) : (
        <>
          <PagedList
            resetKey={`${query}:${window}:${fromDate}:${toDate}:${resetKey ?? ''}`}
            reserve={safePage < pageCount - 1}
          >
            <div style={{ marginTop: 14 }}>
              {groups.map((group) => (
                <div key={group.label} className="hist-group">
                  <div className="hist-group__day">{group.label}</div>
                  {/* The gap lives on this container, not between the rows.
                      Row spacing used to come from a `.trow + .trow` rule, and
                      every row here is wrapped in its own element for its key, so
                      the rows are never siblings and the rule never matched: the
                      cards sat flush against each other. A column gap does not
                      care what the row is made of. */}
                  <div className="hist-group__rows">
                    {group.items.map((item) => (
                      <div key={rowKey(item)}>{renderRow(item)}</div>
                    ))}
                  </div>
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
