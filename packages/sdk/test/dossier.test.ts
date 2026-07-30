import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { clampVerdict, findNearMisses, type Advisory } from '../src/risk/dossier.js';
import type { RiskLevel } from '../src/risk/types.js';

const LEVELS: RiskLevel[] = ['safe', 'warning', 'block'];

const advisory = (level: RiskLevel): Advisory => ({
  level,
  headline: 'h',
  points: ['p'],
});

describe('clampVerdict — an advisory may only ever tighten', () => {
  it('never returns a level below the rule engine, for any combination', () => {
    const rank = { safe: 0, warning: 1, block: 2 } as const;
    for (const rule of LEVELS) {
      for (const advised of LEVELS) {
        const out = clampVerdict(rule, advisory(advised));
        expect(rank[out.level]).toBeGreaterThanOrEqual(rank[rule]);
      }
    }
  });

  it('cannot un-block a lookalike, however confident it is', () => {
    expect(clampVerdict('block', advisory('safe')).level).toBe('block');
    expect(clampVerdict('block', advisory('warning')).level).toBe('block');
  });

  it('cannot turn a caution into a green light', () => {
    expect(clampVerdict('warning', advisory('safe')).level).toBe('warning');
  });

  it('can escalate, which is the direction it is allowed to move', () => {
    expect(clampVerdict('safe', advisory('warning')).level).toBe('warning');
    expect(clampVerdict('safe', advisory('block')).level).toBe('block');
    expect(clampVerdict('warning', advisory('block')).level).toBe('block');
  });

  it('keeps the prose it was given when it escalates', () => {
    const a = { level: 'block' as const, headline: 'campaign', points: ['a', 'b'] };
    expect(clampVerdict('warning', a)).toEqual(a);
  });

  it('keeps the prose when it is clamped, so the user still sees the reasoning', () => {
    const out = clampVerdict('block', { level: 'safe', headline: 'looks fine', points: ['x'] });
    expect(out).toEqual({ level: 'block', headline: 'looks fine', points: ['x'] });
  });

  it('survives a level outside the enum without downgrading', () => {
    // A model that returns something unexpected must not be able to weaken the
    // verdict; an unknown level ranks as undefined, which is never greater.
    const rogue = { level: 'definitely-fine' as unknown as RiskLevel, headline: '', points: [] };
    expect(clampVerdict('block', rogue).level).toBe('block');
    expect(clampVerdict('warning', rogue).level).toBe('warning');
  });
});

describe('findNearMisses', () => {
  // Every fixture must be a real 40-hex-character body. A short literal still
  // satisfies the `Address` template type at compile time but compares as a
  // different string at runtime, which silently produces no matches.
  const addr = (hex: string): Address => {
    if (hex.length !== 40) throw new Error(`fixture is ${hex.length} chars, need 40: ${hex}`);
    return `0x${hex}` as Address;
  };

  //            aabb ................................ ccdd
  const target = addr('aabbccddeeff00112233445566778899aabbccdd');

  it('finds a counterparty that collides at both ends below the rule threshold', () => {
    // Shares 3 leading and 3 trailing hex characters — under the 4 the rule needs.
    const near = addr('aab0111111111111111111111111111111110cdd');
    const found = findNearMisses(target, [near]);
    expect(found).toHaveLength(1);
    expect(found[0]!.sharedPrefix).toBe(3);
    expect(found[0]!.sharedSuffix).toBe(3);
  });

  it("ignores an exact lookalike — that is the rule engine's job, not this one's", () => {
    const lookalike = addr('aabb11111111111111111111111111111111ccdd');
    expect(findNearMisses(target, [lookalike])).toEqual([]);
  });

  it('ignores the target itself', () => {
    expect(findNearMisses(target, [target])).toEqual([]);
  });

  it('ignores a collision at only one end', () => {
    const prefixOnly = addr('aabb111111111111111111111111111111111111');
    const suffixOnly = addr('111111111111111111111111111111111111ccdd');
    expect(findNearMisses(target, [prefixOnly, suffixOnly])).toEqual([]);
  });

  it('ignores an unrelated address', () => {
    expect(findNearMisses(target, [addr('1234567890123456789012345678901234567890')])).toEqual([]);
  });

  it('is case-insensitive, so checksummed input does not hide a collision', () => {
    const near = addr('AAB0111111111111111111111111111111110CDD');
    expect(findNearMisses(target, [near])).toHaveLength(1);
  });

  it('ranks the closest collision first', () => {
    const weak = addr('aa011111111111111111111111111111111110dd');
    const strong = addr('aab0111111111111111111111111111111110cdd');
    const found = findNearMisses(target, [weak, strong]);
    expect(found[0]!.counterparty).toBe(strong);
    expect(found).toHaveLength(2);
  });

  it('returns nothing for a sender with no history', () => {
    expect(findNearMisses(target, [])).toEqual([]);
  });
});
