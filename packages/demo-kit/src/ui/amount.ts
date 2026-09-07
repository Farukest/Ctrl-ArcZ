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
 * Which way a figure is allowed to bend when it is shortened for reading.
 *
 * Not a detail. A balance rounded up is a promise the chain will not keep: "2.65
 * spendable" over 2.646169 sends whoever types the number they were shown into a
 * shortfall. A fee rounded down is the same lie from the other end. So money that
 * limits what you can do rounds `down`, money you have to pay rounds `up`, and
 * `near` is for the figures that are neither, like an amount already agreed.
 */
export type Rounding = 'down' | 'up' | 'near';

/** Decimals an ordinary figure gets. Two, because these are dollars. */
const DISPLAY_FRACTION = 2;

/**
 * How much of a small number has to survive before the shortening gives up.
 *
 * Two decimals turn a 0.0035 fee into "0.00", which is not a small number, it is
 * a broken row: the reader concludes the app does not know what it charges. So a
 * figure that would round away opens up one decimal at a time until two digits of
 * it are actually visible, and never past what the token can hold.
 */
const MIN_SIGNIFICANT = 2;

/**
 * Subunits as a person should read them, which is not how a chain stores them.
 *
 * Six decimals is what USDC is denominated in, not what a balance is worth
 * reading in, and eight is what cirBTC is denominated in. Printing the storage
 * precision put "191.981099 USDC" beside "0.761693 USDC" on the bridge, so every
 * figure on the screen was six digits wide and none of them was easier to compare
 * than its neighbour.
 *
 * This is the only function that shortens an amount. `formatAmount` stays exact
 * and stays the one that fills fields, because what is shown and what gets signed
 * are different questions and answering both with one string is how a Max button
 * ends up offering a number the next check refuses.
 */
export function displayAmount(
  subunits: bigint,
  decimals = USDC_DECIMALS,
  round: Rounding = 'down',
): string {
  const neg = subunits < 0n;
  const v = neg ? -subunits : subunits;
  const sign = neg ? '-' : '';
  // A figure with a whole part carries its own magnitude, so two decimals is
  // always enough there and the widening below is only ever about fractions.
  const hasWhole = v >= 10n ** BigInt(decimals);

  const floor = Math.min(DISPLAY_FRACTION, decimals);
  let d = floor;
  for (;;) {
    /*
     * Decided on the trimmed form and printed on the padded one, which are two
     * different questions. Trimmed is how you tell whether widening would reveal
     * anything: at six decimals a 0.01 fee still trims to "0.01", so the loop
     * stops rather than marching out to "0.010000". Padded is how it reads.
     */
    const s = render(shorten(v, decimals, d, round), d);
    if (hasWhole || d >= decimals || significantDigits(s) >= MIN_SIGNIFICANT) {
      return `${sign}${pad(s, floor)}`;
    }
    d += 1;
  }
}

/** A cost, shortened the way a cost has to be: never smaller than it is. */
export function displayCost(subunits: bigint, decimals = USDC_DECIMALS): string {
  return displayAmount(subunits, decimals, 'up');
}

/**
 * A non-negative subunit count restated in units of `10 ** -d`.
 *
 * The sign is handled outside, so `down` is always toward zero and `up` always
 * away from it: a figure's magnitude is never overstated by one and never
 * understated by the other, whichever side of zero it sits on.
 */
function shorten(v: bigint, decimals: number, d: number, round: Rounding): bigint {
  if (d >= decimals) return v * 10n ** BigInt(d - decimals);
  const drop = 10n ** BigInt(decimals - d);
  const kept = v / drop;
  const lost = v % drop;
  if (lost === 0n) return kept;
  if (round === 'up') return kept + 1n;
  if (round === 'near') return lost * 2n >= drop ? kept + 1n : kept;
  return kept;
}

/** Units of `10 ** -d` as text, trailing zeros dropped: "0.010" is not a figure. */
function render(scaled: bigint, d: number): string {
  if (d === 0) return scaled.toString();
  const unit = 10n ** BigInt(d);
  const frac = (scaled % unit).toString().padStart(d, '0').replace(/0+$/, '');
  return `${scaled / unit}${frac ? `.${frac}` : ''}`;
}

/**
 * The same figure carried out to `min` decimals, so a column of money lines up.
 *
 * Only on the way to the screen. Trimming is right for a field, where "1.50" is a
 * number somebody has to backspace through and "176.5" is what they would have
 * typed; it is wrong for a balance, where a stray "176.5" between "0.76" and
 * "2.56" reads as a figure that lost a digit. `formatAmount` keeps trimming for
 * exactly that reason.
 *
 * Never truncates: a figure that has already widened past `min` to stay legible
 * (a 0.0035 fee) keeps every decimal it earned.
 */
function pad(s: string, min: number): string {
  if (min <= 0) return s;
  const dot = s.indexOf('.');
  if (dot === -1) return `${s}.${'0'.repeat(min)}`;
  const have = s.length - dot - 1;
  return have >= min ? s : s + '0'.repeat(min - have);
}

/** Digits that say something: leading zeros and the point do not. */
function significantDigits(s: string): number {
  return s.replace('.', '').replace(/^0+/, '').length;
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
