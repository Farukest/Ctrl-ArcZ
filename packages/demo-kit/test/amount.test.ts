import { describe, expect, it } from 'vitest';
import { fiat, formatAmount, humanDuration, parseAmount, sanitizeAmount } from '../src/ui/amount.js';

/**
 * What may be typed into an amount, and what that text means.
 *
 * This used to be four rules in four screens: one stripped non-digits, one let
 * "1.2.3" through, one did nothing at all and handed the text to `Number()`. The
 * tests here are the cases those disagreed on, plus the half-finished states a
 * field legitimately holds while someone is still typing.
 */

describe('sanitizeAmount', () => {
  it('keeps a plain number', () => {
    expect(sanitizeAmount('12.34')).toBe('12.34');
  });

  it('drops anything that is not a digit or a point', () => {
    expect(sanitizeAmount('1a2b3')).toBe('123');
    expect(sanitizeAmount('abc')).toBe('');
    expect(sanitizeAmount('-5')).toBe('5');
    expect(sanitizeAmount('1e9')).toBe('19');
  });

  it('keeps the first point and drops the rest', () => {
    // Refusing the keystroke outright reads as a stuck field; this does the
    // obvious thing with it instead.
    expect(sanitizeAmount('1.2.3')).toBe('1.23');
    expect(sanitizeAmount('....')).toBe('.');
  });

  it('accepts a comma as a decimal point', () => {
    expect(sanitizeAmount('1,5')).toBe('1.5');
  });

  it('allows the half-finished states a field holds mid-keystroke', () => {
    expect(sanitizeAmount('')).toBe('');
    expect(sanitizeAmount('.')).toBe('.');
    expect(sanitizeAmount('1.')).toBe('1.');
    expect(sanitizeAmount('0.')).toBe('0.');
  });

  it('cuts decimals past the sixth', () => {
    // A seventh decimal is not a smaller payment, it is one parseUnits rejects.
    expect(sanitizeAmount('1.1234567')).toBe('1.123456');
    expect(sanitizeAmount('0.0000001')).toBe('0.000000');
  });

  it('strips leading zeros without eating a decimal', () => {
    expect(sanitizeAmount('007')).toBe('7');
    expect(sanitizeAmount('0.5')).toBe('0.5');
    expect(sanitizeAmount('0')).toBe('0');
    expect(sanitizeAmount('00')).toBe('0');
  });
});

describe('parseAmount', () => {
  it('reads whole and fractional parts', () => {
    expect(parseAmount('1')).toBe(1_000_000n);
    expect(parseAmount('1.5')).toBe(1_500_000n);
    expect(parseAmount('0.000001')).toBe(1n);
    expect(parseAmount('201.424116')).toBe(201_424_116n);
  });

  it('is null for text that is not yet a number', () => {
    // Null rather than zero: "not typed" and "typed zero" lead to different
    // screens, and collapsing them enables a button over an empty field.
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('.')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  it('reads a half-finished decimal as the number so far', () => {
    expect(parseAmount('1.')).toBe(1_000_000n);
    expect(parseAmount('0.')).toBe(0n);
  });

  it('agrees with the filter, so a field can never hold what this refuses', () => {
    for (const raw of ['1.2.3', '007', '1,5', '9.9999999', 'abc12']) {
      const cleaned = sanitizeAmount(raw);
      expect(sanitizeAmount(cleaned)).toBe(cleaned);
      // Whatever survives the filter parses, or is one of the half-typed states.
      const parsed = parseAmount(cleaned);
      if (cleaned !== '' && cleaned !== '.') expect(parsed).not.toBeNull();
    }
  });

  it('handles a figure far larger than any balance without overflowing', () => {
    expect(parseAmount('999999999999.999999')).toBe(999_999_999_999_999_999n);
  });
});

describe('formatAmount', () => {
  it('round-trips through parseAmount', () => {
    for (const s of ['0', '1', '1.5', '0.000001', '201.424116', '3.285738']) {
      expect(formatAmount(parseAmount(s)!)).toBe(s);
    }
  });

  it('trims trailing zeros but not zeros inside the fraction', () => {
    expect(formatAmount(1_500_000n)).toBe('1.5');
    expect(formatAmount(1_050_000n)).toBe('1.05');
    expect(formatAmount(1_000_000n)).toBe('1');
    expect(formatAmount(0n)).toBe('0');
  });
});

describe('fiat', () => {
  it('shows USDC at a dollar, to two places', () => {
    expect(fiat('1')).toBe('$1.00');
    expect(fiat('12.5')).toBe('$12.50');
    expect(fiat('0.004')).toBe('$0.00');
    expect(fiat('0.006')).toBe('$0.01');
  });

  it('is zero for an empty or unparsable field', () => {
    expect(fiat('')).toBe('$0.00');
    expect(fiat('.')).toBe('$0.00');
  });
});

describe('humanDuration', () => {
  const u = (n: number, unit: string) => `${n} ${unit}`;

  it('picks the unit a person would use at each scale', () => {
    expect(humanDuration(300, u)).toBe('5 minute');
    expect(humanDuration(3 * 3600, u)).toBe('3 hour');
    expect(humanDuration(7 * 86400, u)).toBe('7 day');
    // Six weeks is not forty-two days, even though it is.
    expect(humanDuration(42 * 86400, u)).toBe('6 week');
    expect(humanDuration(365 * 86400, u)).toBe('12 month');
    expect(humanDuration(3 * 365 * 86400, u)).toBe('3 year');
  });

  it('never says zero of anything', () => {
    // A subscription that runs for one interval still runs; "0 min" reads as a
    // form that has not been filled in.
    expect(humanDuration(0, u)).toBe('1 minute');
    expect(humanDuration(1, u)).toBe('1 minute');
    expect(humanDuration(-5, u)).toBe('1 minute');
  });

  it('crosses each boundary without skipping a unit', () => {
    expect(humanDuration(89, u)).toBe('1 minute');
    expect(humanDuration(90, u)).toBe('2 minute');
    expect(humanDuration(89 * 60, u)).toBe('89 minute');
    expect(humanDuration(90 * 60, u)).toBe('2 hour');
    expect(humanDuration(35 * 3600, u)).toBe('35 hour');
    expect(humanDuration(36 * 3600, u)).toBe('2 day');
    expect(humanDuration(13 * 86400, u)).toBe('13 day');
    expect(humanDuration(14 * 86400, u)).toBe('2 week');
    expect(humanDuration(59 * 86400, u)).toBe('8 week');
    expect(humanDuration(60 * 86400, u)).toBe('2 month');
  });
});
