import { describe, expect, it } from 'vitest';
// Straight at the source: the dictionaries are not part of the package's public
// surface, and this is a test about what is in them.
import { en } from '../../../packages/demo-kit/src/i18n/en.js';
import { tr } from '../../../packages/demo-kit/src/i18n/tr.js';
import { SENT_STATUS_KEY } from '../src/lib/activityEntries.js';

/**
 * Every status a transfer can be in has a word for it.
 *
 * The label was built as `active.status.${status.toLowerCase()}`, which the
 * compiler cannot check, so a status with no entry reached the screen as its own
 * key: a reader looking at their Sent list saw `active.status.cancelled` where a
 * word should have been. Six statuses existed and five had labels.
 *
 * The table is keyed by the union now, so a missing status is a build error. This
 * covers the other half, which types cannot: that the key the table names is one
 * the dictionary actually has, in both languages.
 */
describe('sent status labels', () => {
  const statuses = Object.keys(SENT_STATUS_KEY) as (keyof typeof SENT_STATUS_KEY)[];

  it('covers every status the chain can report', () => {
    // The union from the SDK, restated here on purpose: if it grows, this fails
    // and names the one that was forgotten.
    expect(statuses.sort()).toEqual(
      ['CANCELLED', 'CLAIMED', 'LOCKED', 'NONE', 'PENDING', 'RECLAIMED'].sort(),
    );
  });

  it('names a key both dictionaries actually carry', () => {
    for (const status of statuses) {
      const key = SENT_STATUS_KEY[status];
      expect(en, `English is missing ${key}`).toHaveProperty(key);
      expect(tr, `Turkish is missing ${key}`).toHaveProperty(key);
    }
  });

  it('never shows a key where a word belongs', () => {
    for (const status of statuses) {
      const key = SENT_STATUS_KEY[status];
      const label = (en as Record<string, string>)[key];
      expect(label).toBeTruthy();
      // A label that still looks like a key is the symptom this exists to catch.
      expect(label).not.toMatch(/^[a-z]+\.[a-z]+\./);
    }
  });
});
