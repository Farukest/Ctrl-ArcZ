import type { ReactNode } from 'react';
import { CopyButton, Input } from './components.js';

/**
 * A pay-per-request budget, drawn as what is left of it.
 *
 * The gauge is the whole point of the screen: a balance that falls a few tenths of
 * a cent at a time is invisible as a number and obvious as an arc. Tone follows the
 * fraction left, so the word under the figure changes when the budget does and
 * nobody has to read the stats to know it is running low.
 */
export type GaugeTone = 'ok' | 'warn' | 'critical' | 'empty';

export function gaugeTone(fraction: number | null, requestsLeft: number | null): GaugeTone {
  if (fraction == null) return 'empty';
  if (fraction <= 0 || requestsLeft === 0) return 'empty';
  if (fraction < 0.2 || (requestsLeft != null && requestsLeft < 5)) return 'critical';
  if (fraction < 0.5) return 'warn';
  return 'ok';
}

export function UsageGauge({
  fraction,
  tone,
  status,
}: {
  /** 0 to 1, or null while there is nothing to measure. */
  fraction: number | null;
  tone: GaugeTone;
  status: ReactNode;
}) {
  const pct = fraction == null ? 0 : Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className={`gauge gauge--${tone}`} data-testid="nano-gauge">
      <svg viewBox="0 0 200 112" className="gauge__svg" aria-hidden>
        <path className="gauge__track" d="M 20 100 A 80 80 0 0 1 180 100" pathLength={100} />
        <path
          className="gauge__value"
          d="M 20 100 A 80 80 0 0 1 180 100"
          pathLength={100}
          strokeDasharray={`${pct} 100`}
        />
      </svg>
      <div className="gauge__center">
        <span className="gauge__pct" data-testid="nano-gauge-pct">
          {fraction == null ? '-' : `${Math.round(pct)}%`}
        </span>
        <span className="gauge__status">{status}</span>
      </div>
    </div>
  );
}

export interface MeterStat {
  label: ReactNode;
  value: ReactNode;
  testId?: string;
}

/** Stats on the left, gauge on the right; stacked on a phone. */
export function NanoMeter({
  stats,
  gauge,
}: {
  stats: readonly MeterStat[];
  gauge: ReactNode;
}) {
  return (
    <div className="nanometer">
      <dl className="nanometer__stats">
        {stats.map((s, i) => (
          <div key={i} className="nanometer__stat">
            <dt>{s.label}</dt>
            <dd data-testid={s.testId}>{s.value}</dd>
          </div>
        ))}
      </dl>
      {gauge}
    </div>
  );
}

export interface UsageItem {
  id: string;
  time: string;
  title: ReactNode;
  detail: ReactNode;
  amount: ReactNode;
  status: ReactNode;
  /** Arrived since the list was last drawn: drawn once with an entrance. */
  fresh?: boolean;
}

/** The request log: one row per paid request, newest first. */
export function UsageFeed({ items, empty }: { items: readonly UsageItem[]; empty: ReactNode }) {
  if (items.length === 0) return <p className="usagefeed__empty">{empty}</p>;
  return (
    <ul className="usagefeed" data-testid="nano-feed">
      {items.map((it) => (
        <li key={it.id} className={`usagefeed__row${it.fresh ? ' usagefeed__row--fresh' : ''}`}>
          <span className="usagefeed__time">{it.time}</span>
          <span className="usagefeed__main">
            <span className="usagefeed__title">{it.title}</span>
            <span className="usagefeed__detail">{it.detail}</span>
          </span>
          <span className="usagefeed__side">
            <span className="usagefeed__amount">{it.amount}</span>
            <span className="usagefeed__status">{it.status}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A value to copy out, named on its left: an endpoint, a key. */
export function CopyRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="copyrow">
      <span className="copyrow__label">{label}</span>
      <Input mono readOnly value={value} aria-label={label} data-testid={testId} />
      <CopyButton value={value} label={label} />
    </div>
  );
}
