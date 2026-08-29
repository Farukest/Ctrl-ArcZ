import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CCTP_CHAINS, type CctpChainName } from '@ctrl-arcz/sdk';

/**
 * The brand marks, and the four things that make one safe to inline.
 *
 * `ChainLogo` drops these straight into the page with `dangerouslySetInnerHTML`,
 * which is the right call for an icon -- no request, crisp at any size, and legible
 * on both themes -- and it means a file in this folder is markup running on the page
 * rather than an asset being loaded onto it. So the folder gets checked.
 *
 * Every rule here is a failure that would be quiet rather than loud: a duplicate
 * gradient id paints one chain in another's colours, an external `href` is a request
 * the app never meant to make, and a viewBox that is not 24x24 sits a pixel off the
 * grid in a row of eleven other logos.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'chain-logos');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.svg'));
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

describe('every chain logo is safe to inline', () => {
  it('there are some, so a glob that broke would not pass silently', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('is an svg on the same 24x24 grid as the others', () => {
    for (const f of FILES) {
      const s = read(f);
      expect(s.trimStart().startsWith('<svg'), f).toBe(true);
      expect(s, f).toContain('viewBox="0 0 24 24"');
    }
  });

  it('reaches for nothing outside the page', () => {
    // These are inlined, so anything remote in here is a request made from every
    // screen that draws a chain. The app ships without a CSP so the browser can
    // reach Circle and the chains it bridges between; an icon is not on that list.
    for (const f of FILES) {
      const s = read(f);
      expect(s, `${f}: script`).not.toMatch(/<script/i);
      expect(s, `${f}: raster image`).not.toMatch(/<image[\s>]/i);
      expect(s, `${f}: external href`).not.toMatch(/href\s*=\s*"https?:\/\//i);
      expect(s, `${f}: external url()`).not.toMatch(/url\(\s*['"]?https?:\/\//i);
    }
  });

  it('never shares an id between two files', () => {
    /*
     * The one that would be hard to spot. Gradients and masks are referenced by
     * `url(#id)`, and every one of these ends up in the same document, so two files
     * using `a` means whichever mounted last wins and one chain paints with the
     * other's colours. Arc's mark is a gradient, so this is not hypothetical.
     */
    const seen = new Map<string, string>();
    for (const f of FILES) {
      for (const [, id] of read(f).matchAll(/\sid="([^"]+)"/g)) {
        const owner = seen.get(id);
        expect(owner, `id "${id}" is in both ${owner} and ${f}`).toBeUndefined();
        seen.set(id, f);
      }
    }
  });

  it('is named for a chain this app knows', () => {
    // A file named for a chain that does not exist is a logo nobody will ever see,
    // and the most likely reason for one is a rename that half happened.
    const known = new Set(Object.keys(CCTP_CHAINS) as CctpChainName[]);
    for (const f of FILES) expect(known.has(f.replace(/\.svg$/, '') as CctpChainName), f).toBe(true);
  });
});

/**
 * Which chains still fall back to their initials.
 *
 * Pinned by name rather than by a count, because the interesting question is not
 * how many are missing but which: a chain joining this list means a network was
 * added without a mark, and a chain leaving it means somebody found one. Both are
 * worth reading in a diff.
 */
describe('the chains with no mark', () => {
  it('are the three nobody publishes one for', () => {
    const have = new Set(FILES.map((f) => f.replace(/\.svg$/, '')));
    const missing = (Object.keys(CCTP_CHAINS) as CctpChainName[]).filter((c) => !have.has(c));
    expect(missing.sort()).toEqual(['Edge_Testnet', 'Morph_Hoodi', 'Pharos_Testnet']);
  });
});
