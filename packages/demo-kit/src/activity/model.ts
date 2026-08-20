/**
 * One shape for everything that has ever happened to a wallet, and the engine
 * that searches it.
 *
 * Four screens were each answering the same question in their own vocabulary: a
 * protected transfer, an explorer transaction, a bridge run and a subscription
 * funding are four different records, and each grew its own list, its own filter
 * chips, its own idea of what a row looks like and its own bug when the fifth
 * thing was added. None of that difference survives contact with the reader, who
 * is asking one question: what happened, when, for how much, and did it work.
 *
 * So the sources produce `ActivityEntry` and nothing else, and everything
 * downstream -- searching, filtering, sorting, paging, grouping by day, drawing a
 * row, drawing the detail behind it -- is written once against that.
 *
 * Deliberately free of React and of JSX. A row's appearance is described here as
 * data, not as markup, so this file can be tested in a plain runtime and so the
 * component that draws a chain logo stays the only thing that knows how.
 */

/** How a list is ordered. `largest` sorts by size, which needs a comparable number. */
export type ActivitySort = 'newest' | 'oldest' | 'largest';

export type ActivityTone = 'ok' | 'warn' | 'err' | 'idle';

/** The mark on the left of a row. The component decides what each one looks like. */
export type ActivityIcon =
  | { kind: 'chain'; id: string }
  | { kind: 'route'; from: string; to: string }
  | { kind: 'token'; symbol: string; direction?: 'in' | 'out' }
  | { kind: 'status'; tone: ActivityTone };

export interface ActivityView {
  icon: ActivityIcon;
  /** The line read first: "Sent", "#127", a chain's name. */
  title: string;
  /** Under it, when the title does not say enough on its own. */
  subtitle?: string;
  /** Already formatted, sign included where the direction is known. */
  amount?: string;
  /** Small labels after the row: `Deposit`, `CCTP`, a subscription's name. */
  chips?: readonly string[];
  status: { tone: ActivityTone; label: string };
}

/** A label and a value in the detail view. Data, so it can be copied or opened. */
export interface ActivityFact {
  label: string;
  value: string;
  /** Show a copy button. For anything somebody would paste somewhere else. */
  copy?: boolean;
  /** Opens off site, e.g. an explorer. */
  href?: string;
  mono?: boolean;
}

export interface ActivityStep {
  label: string;
  state: 'done' | 'active' | 'pending' | 'skipped' | 'error';
  txHash?: string;
  href?: string;
}

/** Something the row can still do about itself, such as cancelling a transfer. */
export interface ActivityAction {
  id: string;
  label: string;
  tone?: 'danger';
  /** Present but not offerable right now, with the reason as the title. */
  disabled?: boolean;
}

export interface ActivityEntry {
  id: string;
  /** Epoch ms. Ordering, day grouping and the date filter all read this. */
  at: number;
  /**
   * What `largest` sorts by, in a unit comparable across the rows of one source.
   *
   * Not the display string: "0.940344 USDC" and "1 USDC" sort backwards as text,
   * and every list that has ever sorted money as text has done it wrong at least
   * once.
   */
  magnitude: number;
  /**
   * Everything this row can be matched on, lowercased, joined, built once when
   * the entry is made.
   *
   * The alternative is walking an object per row per keystroke, which is the
   * difference between a search that stays responsive at a hundred thousand rows
   * and one that does not. Callers must lowercase; the engine does not, because
   * doing it here would be doing it again on every query.
   */
  haystack: string;
  /** Which chips this row belongs under, besides `all`. */
  facets: readonly string[];
  view: ActivityView;
  facts: readonly ActivityFact[];
  steps?: readonly ActivityStep[];
  actions?: readonly ActivityAction[];
}

export interface ActivityQuery {
  search: string;
  /** A facet id, or `all`. */
  facet: string;
  sort: ActivitySort;
  /** Local midnight of the chosen day, or null for every day. */
  day: number | null;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export const ALL_FACET = 'all';

export function emptyQuery(pageSize = 10): ActivityQuery {
  return { search: '', facet: ALL_FACET, sort: 'newest', day: null, page: 1, pageSize };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of the day a timestamp falls in. */
export function dayStart(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function matches(entry: ActivityEntry, q: ActivityQuery, needle: string): boolean {
  if (q.facet !== ALL_FACET && !entry.facets.includes(q.facet)) return false;
  if (q.day !== null && (entry.at < q.day || entry.at >= q.day + DAY_MS)) return false;
  if (needle !== '' && !entry.haystack.includes(needle)) return false;
  return true;
}

function compare(a: ActivityEntry, b: ActivityEntry, sort: ActivitySort): number {
  if (sort === 'oldest') return a.at - b.at;
  if (sort === 'largest') return b.magnitude - a.magnitude || b.at - a.at;
  return b.at - a.at;
}

/**
 * Everything matching the query, in order, without paging.
 *
 * Split from paging on purpose: this is the expensive half and it does not change
 * when somebody turns a page, so a caller can hold onto the result and slice it.
 * Filtering happens before sorting, so a search that narrows a hundred thousand
 * rows to nine sorts nine.
 */
export function selectEntries(all: readonly ActivityEntry[], q: ActivityQuery): ActivityEntry[] {
  const needle = q.search.trim().toLowerCase();
  const hits: ActivityEntry[] = [];
  for (const entry of all) if (matches(entry, q, needle)) hits.push(entry);
  hits.sort((a, b) => compare(a, b, q.sort));
  return hits;
}

export interface ActivityPage {
  items: ActivityEntry[];
  /** Rows matching the query, not rows on this page. */
  total: number;
  pages: number;
  /** Clamped: a query that shrinks under a reader cannot leave them past the end. */
  page: number;
}

export function pageOf(selected: readonly ActivityEntry[], q: ActivityQuery): ActivityPage {
  const size = Math.max(1, q.pageSize);
  const pages = Math.max(1, Math.ceil(selected.length / size));
  const page = Math.min(Math.max(1, q.page), pages);
  const from = (page - 1) * size;
  return { items: selected.slice(from, from + size), total: selected.length, pages, page };
}

/**
 * How many rows each chip would show, counted against everything else the reader
 * has already narrowed by.
 *
 * A chip's own facet is deliberately ignored while counting it, or every chip
 * except the selected one would read zero the moment one was chosen -- the count
 * is there to say what switching to it would give you.
 */
export function facetCounts(
  all: readonly ActivityEntry[],
  q: ActivityQuery,
  facets: readonly string[],
): Record<string, number> {
  const base: ActivityQuery = { ...q, facet: ALL_FACET };
  const needle = q.search.trim().toLowerCase();
  const counts: Record<string, number> = {};
  for (const id of facets) counts[id] = 0;
  counts[ALL_FACET] = 0;
  for (const entry of all) {
    if (!matches(entry, base, needle)) continue;
    counts[ALL_FACET] = (counts[ALL_FACET] ?? 0) + 1;
    for (const id of entry.facets) {
      if (id in counts) counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

export interface ActivityDay {
  /** Local midnight, so it can be compared and formatted by the caller. */
  day: number;
  entries: ActivityEntry[];
}

/**
 * A page's rows under the day they happened on.
 *
 * Grouping the page rather than the whole list, because a reader looking at page
 * four should see page four's days and not be told about the other three.
 */
export function groupByDay(entries: readonly ActivityEntry[]): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const entry of entries) {
    const day = dayStart(entry.at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}
