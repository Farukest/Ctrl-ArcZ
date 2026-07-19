import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { check } from '../src/risk/check.js';
import { craftLookalike, evaluateRisk, isLookalike } from '../src/risk/rules.js';
import type {
  AddressActivity,
  CounterpartyScan,
  IDataProvider,
  RiskInput,
} from '../src/risk/types.js';

const SENDER = '0x1111111111111111111111111111111111111111' as Address;

/** A real, long-standing counterparty. */
const REAL = '0x3A5f8b2c9d1e4f6a7b8c9d0e1f2a3b4c5d6e9C2b' as Address;
/**
 * The poisoned twin: identical first four and last four characters, different
 * middle. A wallet renders both as `0x3A5f…9C2b`.
 */
const LOOKALIKE = `0x3A5f${'0'.repeat(32)}9C2b` as Address;
/** An unrelated address. */
const CLEAN = '0x9999888877776666555544443333222211110000' as Address;

const NOW = new Date('2026-07-11T12:00:00Z');
const LONG_AGO = new Date('2025-01-01T00:00:00Z');

function baseInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    sender: SENDER,
    target: CLEAN,
    counterparties: [REAL],
    targetActivity: { transactionCount: 42, firstSeenAt: LONG_AGO },
    zeroValueBait: { count: 0 },
    isVerifiedRecipient: false,
    ...overrides,
  };
}

describe('isLookalike', () => {
  it('matches an address that copies the visible ends', () => {
    expect(isLookalike(LOOKALIKE, REAL)).toBe(true);
  });

  it('is case-insensitive (EIP-55 checksums must not fool it)', () => {
    expect(isLookalike(LOOKALIKE.toLowerCase() as Address, REAL.toUpperCase() as Address)).toBe(
      true,
    );
  });

  it('does not flag the address itself', () => {
    expect(isLookalike(REAL, REAL)).toBe(false);
  });

  it('does not flag an unrelated address', () => {
    expect(isLookalike(CLEAN, REAL)).toBe(false);
  });

  it('does not flag an address that shares only the prefix', () => {
    const prefixOnly = ('0x3A5f' + 'a'.repeat(36)) as Address;
    expect(isLookalike(prefixOnly, REAL)).toBe(false);
  });

  it('does not flag an address that shares only the suffix', () => {
    const suffixOnly = ('0x' + 'a'.repeat(36) + '9C2b') as Address;
    expect(isLookalike(suffixOnly, REAL)).toBe(false);
  });
});

describe('craftLookalike', () => {
  it('produces a valid, different address that its own isLookalike flags', () => {
    const crafted = craftLookalike(REAL);

    expect(crafted).toMatch(/^0x[0-9a-f]{40}$/);
    expect(crafted.toLowerCase()).not.toBe(REAL.toLowerCase());
    expect(isLookalike(crafted, REAL)).toBe(true);
  });

  it('is deterministic when entropy is injected', () => {
    const fixed = () => new Uint8Array(16).fill(0xab);
    expect(craftLookalike(REAL, fixed)).toBe(craftLookalike(REAL, fixed));
  });

  it('the crafted address is blocked by the firewall for a real counterparty', () => {
    const crafted = craftLookalike(REAL);
    const report = evaluateRisk(baseInput({ target: crafted, counterparties: [REAL] }), NOW);
    expect(report.level).toBe('block');
  });
});

describe('evaluateRisk', () => {
  it('passes a clean, established address', () => {
    const report = evaluateRisk(baseInput(), NOW);
    expect(report.level).toBe('safe');
    expect(report.complete).toBe(true);
  });

  it('BLOCKS a lookalike of an address the sender has actually paid', () => {
    const report = evaluateRisk(baseInput({ target: LOOKALIKE }), NOW);

    expect(report.level).toBe('block');
    const reason = report.reasons.find((r) => r.code === 'LOOKALIKE_ADDRESS');
    expect(reason?.lookalikeOf?.toLowerCase()).toBe(REAL.toLowerCase());
  });

  it('BLOCKS an address that baited the sender with a 0-value transfer', () => {
    const report = evaluateRisk(baseInput({ zeroValueBait: { count: 1 } }), NOW);

    expect(report.level).toBe('block');
    expect(report.reasons.map((r) => r.code)).toContain('ZERO_VALUE_BAIT');
  });

  it('WARNS on an address with no history', () => {
    const report = evaluateRisk(
      baseInput({ targetActivity: { transactionCount: 0, firstSeenAt: null } }),
      NOW,
    );

    expect(report.level).toBe('warning');
    expect(report.reasons.map((r) => r.code)).toContain('NEW_ADDRESS');
  });

  it('WARNS on an address first seen less than 24 hours ago', () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const report = evaluateRisk(
      baseInput({ targetActivity: { transactionCount: 3, firstSeenAt: twoHoursAgo } }),
      NOW,
    );

    expect(report.level).toBe('warning');
    expect(report.reasons.map((r) => r.code)).toContain('FRESH_ADDRESS');
  });

  it('does not warn about an address that is just over 24 hours old', () => {
    const yesterday = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const report = evaluateRisk(
      baseInput({ targetActivity: { transactionCount: 3, firstSeenAt: yesterday } }),
      NOW,
    );

    expect(report.level).toBe('safe');
  });

  it('reports an exact counterparty as a known address', () => {
    const report = evaluateRisk(baseInput({ target: REAL }), NOW);

    expect(report.level).toBe('safe');
    expect(report.reasons.map((r) => r.code)).toContain('KNOWN_COUNTERPARTY');
  });

  it('reports a settled protected transfer as a verified recipient', () => {
    const report = evaluateRisk(baseInput({ target: REAL, isVerifiedRecipient: true }), NOW);

    expect(report.reasons.map((r) => r.code)).toContain('VERIFIED_RECIPIENT');
    expect(report.level).toBe('safe');
  });

  /// The critical case: having paid the real address must never launder its twin.
  it('still BLOCKS a lookalike even when the real address is a known counterparty', () => {
    const report = evaluateRisk(
      baseInput({ target: LOOKALIKE, counterparties: [REAL, CLEAN] }),
      NOW,
    );
    expect(report.level).toBe('block');
  });

  /// Layer 3 → layer 1: a verified recipient (fed in as a counterparty) protects
  /// against its own lookalike, even though a protected transfer never appears as
  /// a direct payment to that recipient.
  it('BLOCKS a lookalike of a verified recipient supplied as a counterparty', () => {
    const report = evaluateRisk(baseInput({ target: LOOKALIKE, counterparties: [REAL] }), NOW);
    expect(report.level).toBe('block');
    expect(report.reasons.map((r) => r.code)).toContain('LOOKALIKE_ADDRESS');
  });

  it('BLOCKS on a fresh lookalike that also baited — reporting every reason', () => {
    const report = evaluateRisk(
      baseInput({
        target: LOOKALIKE,
        zeroValueBait: { count: 2 },
        targetActivity: { transactionCount: 1, firstSeenAt: NOW },
      }),
      NOW,
    );

    expect(report.level).toBe('block');
    expect(report.reasons.map((r) => r.code).sort()).toEqual([
      'FRESH_ADDRESS',
      'LOOKALIKE_ADDRESS',
      'ZERO_VALUE_BAIT',
    ]);
  });

  it('never reports safe when a data source was unavailable', () => {
    const report = evaluateRisk(baseInput({ unavailable: ['gönderim geçmişi'] }), NOW);

    expect(report.level).toBe('warning');
    expect(report.complete).toBe(false);
    expect(report.reasons.map((r) => r.code)).toContain('DATA_UNAVAILABLE');
  });

  it('keeps a block when data is also missing', () => {
    const report = evaluateRisk(
      baseInput({ target: LOOKALIKE, unavailable: ['alıcı adres geçmişi'] }),
      NOW,
    );
    expect(report.level).toBe('block');
  });

  it('passes an address with no counterparties to compare against', () => {
    const report = evaluateRisk(baseInput({ counterparties: [] }), NOW);
    expect(report.level).toBe('safe');
  });
});

/** A provider that answers from memory, so `check` can be tested without a network. */
class FakeProvider implements IDataProvider {
  constructor(
    private readonly data: {
      counterparties?: Address[];
      activity?: AddressActivity;
      zeroValue?: number;
      fail?: 'counterparties' | 'activity' | 'zeroValue';
      /** Simulate a history longer than the scan cap (partial, not failed). */
      counterpartiesPartial?: boolean;
    },
  ) {}

  async getOutgoingCounterparties(): Promise<CounterpartyScan> {
    if (this.data.fail === 'counterparties') throw new Error('explorer down');
    return {
      counterparties: this.data.counterparties ?? [],
      complete: this.data.counterpartiesPartial !== true,
    };
  }

  async getAddressActivity(): Promise<AddressActivity> {
    if (this.data.fail === 'activity') throw new Error('explorer down');
    return this.data.activity ?? { transactionCount: 10, firstSeenAt: LONG_AGO };
  }

  async countZeroValueTransfers(): Promise<number> {
    if (this.data.fail === 'zeroValue') throw new Error('explorer down');
    return this.data.zeroValue ?? 0;
  }
}

describe('check', () => {
  it('blocks a lookalike end to end', async () => {
    const report = await check(SENDER, LOOKALIKE, {
      provider: new FakeProvider({ counterparties: [REAL] }),
      now: NOW,
    });

    expect(report.level).toBe('block');
    expect(report.target).toBe(LOOKALIKE);
    expect(report.sender).toBe(SENDER);
  });

  it('passes a clean address end to end', async () => {
    const report = await check(SENDER, CLEAN, {
      provider: new FakeProvider({ counterparties: [REAL] }),
      now: NOW,
    });

    expect(report.level).toBe('safe');
    expect(report.complete).toBe(true);
  });

  it('fails closed: blocks an unverified target when send history is unavailable', async () => {
    // If the sender's payment history can't be fetched, the lookalike rule never
    // runs, so a poisoning lookalike can't be ruled out. For an unverified target
    // the firewall must refuse, not merely warn — never "safe", and here not even
    // "warning".
    const report = await check(SENDER, CLEAN, {
      provider: new FakeProvider({ fail: 'counterparties' }),
      now: NOW,
    });

    expect(report.level).toBe('block');
    expect(report.complete).toBe(false);
    expect(
      report.reasons.some((r) => r.code === 'DATA_UNAVAILABLE' && r.severity === 'block'),
    ).toBe(true);
  });

  it('never reports "safe" on a truncated (partial) counterparty scan', async () => {
    // The history was longer than the scan cap, so a lookalike could match a
    // counterparty we did not page far enough to see. The report must be incomplete
    // (at least a warning), never a clean "safe".
    const report = await check(SENDER, CLEAN, {
      provider: new FakeProvider({ counterparties: [REAL], counterpartiesPartial: true }),
      now: NOW,
    });

    expect(report.complete).toBe(false);
    expect(report.level).not.toBe('safe');
    expect(report.reasons.some((r) => r.code === 'DATA_UNAVAILABLE')).toBe(true);
  });

  it('only warns (not blocks) when a NON-history source is down', async () => {
    // Address-activity down but send history intact: the lookalike rule still ran,
    // so this is incomplete-but-not-blind. Warn, never silently "safe".
    const report = await check(SENDER, CLEAN, {
      provider: new FakeProvider({ counterparties: [REAL], fail: 'activity' }),
      now: NOW,
    });

    expect(report.level).toBe('warning');
    expect(report.complete).toBe(false);
  });

  it('still blocks a 0-value baiter when other sources fail', async () => {
    const report = await check(SENDER, CLEAN, {
      provider: new FakeProvider({ fail: 'counterparties', zeroValue: 1 }),
      now: NOW,
    });

    expect(report.level).toBe('block');
  });
});
