/**
 * What a person is allowed to type into a USDC amount, decided in one place.
 *
 * Every screen that asks for an amount used to filter its own input, or not
 * filter it at all: one stripped non-digits, one accepted "1.2.3", one accepted
 * "abc" and let `Number()` turn it into NaN further down. Three rules for one
 * question is three chances to disagree, and the one that disagreed was the one
 * that let a malformed amount reach `parseUnits`.
 */

/** USDC has six decimals; a seventh is not a smaller payment, it is a rejected one. */
export const USDC_DECIMALS = 6;

/**
 * The typed text, cleaned to something that can become an amount.
 *
 * Deliberately permissive about half-finished input: "", ".", "1." and "0." are
 * all things a field holds mid-keystroke and none of them is an error. What it
 * refuses is text that could never be a number, a second decimal point, and
 * decimals past the sixth.
 */
export function sanitizeAmount(raw: string, decimals = USDC_DECIMALS): string {
  // Commas are what half the world types for a decimal point, and rejecting them
  // silently drops the keystroke instead of doing the obvious thing with it.
  let s = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');

  const first = s.indexOf('.');
  if (first !== -1) {
    // Keep the first point, drop the rest, so "1.2.3" becomes "1.23" rather than
    // being refused outright: a stuck keystroke reads as a broken field.
    s = s.slice(0, first + 1) + s.slice(first + 1).replace(/\./g, '');
  }

  const [whole = '', frac] = s.split('.');
  // A single leading zero, unless a decimal follows it. "007" is not an amount.
  const w = whole.replace(/^0+(?=\d)/, '');
  if (frac === undefined) return w;
  return `${w}.${frac.slice(0, decimals)}`;
}

/**
 * The typed text as USDC subunits, or null when it is not yet a number.
 *
 * Null rather than zero: "not typed yet" and "typed zero" lead to different
 * screens, and collapsing them is how a form enables a button for an empty field.
 */
export function parseAmount(raw: string, decimals = USDC_DECIMALS): bigint | null {
  const s = sanitizeAmount(raw, decimals);
  if (s === '' || s === '.') return null;
  const [whole = '0', frac = ''] = s.split('.');
  if (whole === '' && frac === '') return null;
  const padded = frac.padEnd(decimals, '0').slice(0, decimals);
  try {
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  } catch {
    return null;
  }
}

/** Subunits as the string an amount field should hold: exact, and no trailing zeros. */
export function formatAmount(subunits: bigint, decimals = USDC_DECIMALS): string {
  const unit = 10n ** BigInt(decimals);
  const neg = subunits < 0n;
  const v = neg ? -subunits : subunits;
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * The dollar line under the field.
 *
 * USDC is a dollar, so this is the same number with two decimals rather than a
 * rate lookup. It is here so every screen rounds it the same way.
 */
export function fiat(raw: string): string {
  const subunits = parseAmount(raw);
  if (subunits == null) return '$0.00';
  // Rounded to the nearest cent, not truncated. Truncating printed "$0.00" beside
  // an amount of 0.006, which reads as a broken line rather than as a small
  // number, and the line exists to make the figure above it legible.
  const neg = subunits < 0n;
  const v = neg ? -subunits : subunits;
  const cents = (v + 5_000n) / 10_000n;
  return `${neg ? '-' : ''}$${(Number(cents) / 100).toFixed(2)}`;
}

/**
 * A span of seconds as the phrase a person would use for it.
 *
 * Written because an end date was being printed as a full locale timestamp:
 * "Ends 8/9/2026, 2:23:00 AM" for a subscription running a year, seconds and all.
 * Nobody needs the second, and at the other end of the scale a bare date is no use
 * either, because a five-minute test subscription ends today. A duration reads
 * correctly at both ends.
 *
 * Rounded down to the largest unit that fits, so "89 days" is "2 months" rather
 * than a number the reader has to divide themselves.
 */
export function humanDuration(seconds: number, unit: (n: number, u: DurationUnit) => string): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return unit(Math.max(1, Math.round(s / 60)), 'minute');
  const m = s / 60;
  if (m < 90) return unit(Math.round(m), 'minute');
  const h = m / 60;
  if (h < 36) return unit(Math.round(h), 'hour');
  const d = h / 24;
  if (d < 14) return unit(Math.round(d), 'day');
  // Weeks, because the form offers a weekly subscription and six of them read as
  // "6 weeks" rather than as the 42 days they also are.
  if (d < 60) return unit(Math.round(d / 7), 'week');
  const mo = d / 30;
  if (mo < 18) return unit(Math.round(mo), 'month');
  return unit(Math.round(d / 365), 'year');
}

export type DurationUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
