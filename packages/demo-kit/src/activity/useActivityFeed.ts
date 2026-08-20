import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ALL_FACET,
  facetCounts,
  groupByDay,
  pageOf,
  selectEntries,
  type ActivityDay,
  type ActivityEntry,
  type ActivityPage,
  type ActivityQuery,
  type ActivitySort,
} from './model.js';

/**
 * The state behind an activity list: what the reader has narrowed to, and the
 * page that falls out of it.
 *
 * Every screen that shows a list of things that happened used to hold this for
 * itself -- a search string, a filter, a page number, and the four rules about
 * when to reset the page that each of them got slightly differently. The rules
 * live here now, and there is one of them.
 */

/** How long the list waits after a keystroke before narrowing. */
const DEBOUNCE_MS = 200;

export interface ActivityFacetOption {
  id: string;
  label: string;
}

export interface ActivityFeed {
  /** What the search box shows, which leads the query it produces. */
  searchInput: string;
  setSearch: (value: string) => void;
  query: ActivityQuery;
  setFacet: (id: string) => void;
  setSort: (sort: ActivitySort) => void;
  /** Local midnight, or null for every day. */
  setDay: (day: number | null) => void;
  setPage: (page: number) => void;
  page: ActivityPage;
  days: ActivityDay[];
  counts: Record<string, number>;
  /** True while the reader has typed something the list has not caught up to. */
  settling: boolean;
}

export function useActivityFeed(
  entries: readonly ActivityEntry[],
  facets: readonly ActivityFacetOption[],
  pageSize = 10,
): ActivityFeed {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearchNow] = useState('');
  const [facet, setFacetState] = useState(ALL_FACET);
  const [sort, setSortState] = useState<ActivitySort>('newest');
  const [day, setDayState] = useState<number | null>(null);
  const [page, setPageState] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  /*
   * The box leads, the list follows.
   *
   * Narrowing on every keystroke is what makes a long list feel like it is
   * fighting the keyboard: each character re-runs the pass, and at a hundred
   * thousand rows the fourth character lands while the first is still being
   * matched. The input stays immediate so typing never lags; the query catches up
   * once somebody stops.
   */
  const setSearch = useCallback((value: string) => {
    setSearchInput(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSearchNow(value), DEBOUNCE_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Narrowing by anything puts the reader back at the start. Without this, a
  // filter that leaves three rows while they are on page four shows them nothing
  // and blames the filter.
  useEffect(() => setPageState(1), [search, facet, sort, day]);

  const selection: ActivityQuery = useMemo(
    () => ({ search, facet, sort, day, page: 1, pageSize }),
    [search, facet, sort, day, pageSize],
  );

  /*
   * The expensive half, kept away from the cheap one.
   *
   * Filtering and sorting depend on the query minus the page, so turning a page
   * does not redo them -- it slices what is already in hand. That is the
   * difference between paging being instant and paging costing a full pass.
   */
  const selected = useMemo(() => selectEntries(entries, selection), [entries, selection]);
  const counts = useMemo(
    () =>
      facetCounts(
        entries,
        selection,
        facets.map((f) => f.id),
      ),
    [entries, selection, facets],
  );
  const current = useMemo(
    () => pageOf(selected, { ...selection, page }),
    [selected, selection, page],
  );
  const days = useMemo(() => groupByDay(current.items), [current.items]);

  return {
    searchInput,
    setSearch,
    query: { ...selection, page: current.page },
    setFacet: setFacetState,
    setSort: setSortState,
    setDay: setDayState,
    setPage: setPageState,
    page: current,
    days,
    counts,
    settling: searchInput.trim() !== search.trim(),
  };
}
