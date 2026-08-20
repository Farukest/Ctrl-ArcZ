import { describe, expect, it } from 'vitest';
import {
  ALL_FACET,
  dayStart,
  emptyQuery,
  facetCounts,
  groupByDay,
  pageOf,
  selectEntries,
  type ActivityEntry,
  type ActivityQuery,
} from '../src/activity/model.js';

/**
 * The engine every activity list runs on, tested without a DOM.
 *
 * These are the rules four screens used to each implement for themselves, which
 * is why they disagreed: one searched the amount and another did not, one reset
 * the page when the filter changed and another left the reader past the end.
 */

function entry(over: Partial<ActivityEntry> & { id: string; at: number }): ActivityEntry {
  return {
    magnitude: 0,
    haystack: over.id.toLowerCase(),
    facets: [],
    view: {
      icon: { kind: 'status', tone: 'ok' },
      title: over.id,
      status: { tone: 'ok', label: 'ok' },
    },
    facts: [],
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const noon = (dayOffset: number) => dayStart(Date.parse('2026-08-20T12:00:00')) + dayOffset * DAY;

const ROWS: ActivityEntry[] = [
  entry({
    id: 'a',
    at: noon(0) + 3,
    magnitude: 5,
    haystack: 'sent 0xaaa 5 usdc',
    facets: ['sent'],
  }),
  entry({
    id: 'b',
    at: noon(0) + 2,
    magnitude: 100,
    haystack: 'sent 0xbbb 100 usdc',
    facets: ['sent', 'pending'],
  }),
  entry({
    id: 'c',
    at: noon(0) + 1,
    magnitude: 1,
    haystack: 'received 0xccc 1 eurc',
    facets: ['received'],
  }),
  entry({
    id: 'd',
    at: noon(-1),
    magnitude: 50,
    haystack: 'received 0xddd 50 usdc',
    facets: ['received'],
  }),
];

const q = (over: Partial<ActivityQuery> = {}): ActivityQuery => ({ ...emptyQuery(2), ...over });

describe('selectEntries', () => {
  it('orders newest first by default', () => {
    expect(selectEntries(ROWS, q()).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('orders by size when asked, and breaks ties by time', () => {
    expect(selectEntries(ROWS, q({ sort: 'largest' })).map((r) => r.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });

  it('orders oldest first when asked', () => {
    expect(selectEntries(ROWS, q({ sort: 'oldest' })).map((r) => r.id)).toEqual([
      'd',
      'c',
      'b',
      'a',
    ]);
  });

  it('searches the haystack, not the id', () => {
    expect(selectEntries(ROWS, q({ search: 'eurc' })).map((r) => r.id)).toEqual(['c']);
    // Case and surrounding spaces are the reader's, not the data's.
    expect(selectEntries(ROWS, q({ search: '  0xBBB ' })).map((r) => r.id)).toEqual(['b']);
  });

  it('narrows to a facet', () => {
    expect(selectEntries(ROWS, q({ facet: 'received' })).map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('narrows to a single day, and a day is local midnight to local midnight', () => {
    expect(selectEntries(ROWS, q({ day: dayStart(noon(0)) })).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(selectEntries(ROWS, q({ day: dayStart(noon(-1)) })).map((r) => r.id)).toEqual(['d']);
  });

  it('combines all of them', () => {
    const out = selectEntries(
      ROWS,
      q({ search: 'usdc', facet: 'sent', day: dayStart(noon(0)), sort: 'largest' }),
    );
    expect(out.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('pageOf', () => {
  it('slices and reports what it sliced from', () => {
    const all = selectEntries(ROWS, q());
    expect(pageOf(all, q({ page: 1 }))).toMatchObject({ total: 4, pages: 2, page: 1 });
    expect(pageOf(all, q({ page: 1 })).items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(pageOf(all, q({ page: 2 })).items.map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('clamps a page that no longer exists', () => {
    // What happens when a search narrows the list under a reader on page four.
    const narrowed = selectEntries(ROWS, q({ search: 'eurc' }));
    const page = pageOf(narrowed, q({ search: 'eurc', page: 4 }));
    expect(page).toMatchObject({ page: 1, pages: 1, total: 1 });
    expect(page.items.map((r) => r.id)).toEqual(['c']);
  });

  it('is one empty page when nothing matches, not zero pages', () => {
    const none = selectEntries(ROWS, q({ search: 'nothing here' }));
    expect(pageOf(none, q({ search: 'nothing here' }))).toMatchObject({
      total: 0,
      pages: 1,
      page: 1,
      items: [],
    });
  });
});

describe('facetCounts', () => {
  it('counts each chip against the rest of the query', () => {
    const counts = facetCounts(ROWS, q(), ['sent', 'received', 'pending']);
    expect(counts).toEqual({ [ALL_FACET]: 4, sent: 2, received: 2, pending: 1 });
  });

  it('ignores the chosen chip, so the other chips still say what they would give', () => {
    // Counting with the facet applied would leave every chip but the chosen one
    // reading zero, which is the opposite of what the number is for.
    const counts = facetCounts(ROWS, q({ facet: 'sent' }), ['sent', 'received']);
    expect(counts).toEqual({ [ALL_FACET]: 4, sent: 2, received: 2 });
  });

  it('still respects the search and the day', () => {
    const counts = facetCounts(ROWS, q({ search: 'usdc' }), ['sent', 'received']);
    expect(counts).toEqual({ [ALL_FACET]: 3, sent: 2, received: 1 });
  });
});

describe('groupByDay', () => {
  it('groups a page under the days it covers, in the page order', () => {
    const days = groupByDay(selectEntries(ROWS, q()));
    expect(days.map((d) => d.entries.map((e) => e.id))).toEqual([['a', 'b', 'c'], ['d']]);
    expect(days[0]?.day).toBe(dayStart(noon(0)));
  });

  it('has nothing to group when the page is empty', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('at a size a person could actually reach', () => {
  it('searches and pages a hundred thousand rows without walking objects', () => {
    const many: ActivityEntry[] = Array.from({ length: 100_000 }, (_, i) =>
      entry({
        id: `row-${i}`,
        at: noon(0) - i * 1000,
        magnitude: i % 997,
        haystack: `sent 0x${i.toString(16)} ${i % 997} usdc`,
        facets: [i % 2 === 0 ? 'sent' : 'received'],
      }),
    );
    const started = Date.now();
    const selected = selectEntries(many, q({ search: '0xff', facet: 'sent', pageSize: 10 }));
    const page = pageOf(selected, q({ search: '0xff', facet: 'sent', pageSize: 10 }));
    const took = Date.now() - started;
    expect(page.items.length).toBe(10);
    expect(page.total).toBe(selected.length);
    // Not a benchmark, a guard: this is one pass over prebuilt strings, and if it
    // ever becomes something else the number moves by an order of magnitude.
    expect(took).toBeLessThan(500);
  });
});
