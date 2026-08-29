/**
 * The block at the bottom of every screen that moves money, and the pill that
 * points at it.
 *
 * Four screens were each answering "what is happening and what just happened" in
 * their own way, and none of them answered it well. A run's progress lived in the
 * screen that started it, in one slot, so a second run had nowhere to go and a
 * reload lost the first. What finished left a toast, which is gone by the time
 * anyone looks for it. The history that did survive was on a different screen from
 * the button that made it.
 *
 * One block, in the same place every time, showing the last few things this wallet
 * did with the one in progress at the top of them. It takes rows rather than
 * records: what a row means differs per screen, what it looks like should not.
 *
 * The pill exists because the block is at the bottom, which is the right place for
 * it and the wrong place to notice it from. It only appears when there is
 * something to point at and the block is not already on screen, and once someone
 * has followed it, it stops pointing at that run -- but not at that run's next
 * state, so a run that later fails raises it again. A pill that keeps insisting
 * after it has been obeyed is noise, and a pill that stays quiet about a failure
 * because it already spoke about the attempt is worse.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isPlainClick } from '../isPlainClick.js';
import { IconCheck, IconExternal } from './icons.js';
import { CopyButton, short } from './components.js';
import type { StepStatus } from '../bridgeProgress.js';
import type { RowTone } from './HistoryRow.js';

export interface ActivityStep {
  /** Already translated. This component does no lookups. */
  label: string;
  status: StepStatus;
  txHash?: string | undefined;
  explorerUrl?: string | undefined;
}

export interface ActivityItem {
  id: string;
  /** What the row is about: a route, a chain, a name. */
  lead: ReactNode;
  amount?: ReactNode;
  /** One word for what kind of move this was: a deposit, CCTP, Gateway. */
  kind?: string;
  /** What it cost, already worded, for the routes that charge. */
  fee?: string;
  status: { tone: RowTone; label: string };
  time: string;
  /** A line under the head, for a subscription's name or a failure's reason. */
  note?: ReactNode;
  steps: readonly ActivityStep[];
  /**
   * Whether this row is worth interrupting someone for, and what about it is.
   *
   * The screen decides, because only it knows whether `pending` means a wait that
   * is going fine or a transfer that should have landed by now.
   */
  attention?: 'running' | 'failed' | undefined;
}

export interface ActivityLabels {
  title: string;
  empty: string;
  all: string;
  /** All three carry `{n}`. */
  running: string;
  failed: string;
  /** Just made, still fine: "1 new" rather than an alarm. */
  fresh: string;
  jump: string;
}

/** How long a row stays lit after someone has been sent to it. */
const HIGHLIGHT_MS = 3500;

function StepChip({ step }: { step: ActivityStep }) {
  return (
    <span className={`achip achip--${step.status}`}>
      <span className="achip__mark" aria-hidden>
        {step.status === 'done' ? (
          <IconCheck width={11} height={11} />
        ) : step.status === 'active' ? (
          <span className="spinner" style={{ width: 11, height: 11 }} />
        ) : step.status === 'error' ? (
          '!'
        ) : step.status === 'skipped' ? (
          '-'
        ) : (
          ''
        )}
      </span>
      <span className="achip__name">{step.label}</span>
      {step.txHash && (
        <>
          {step.explorerUrl && /^https:\/\//i.test(step.explorerUrl) ? (
            <a
              className="achip__go"
              href={step.explorerUrl}
              target="_blank"
              rel="noreferrer"
              title={step.txHash}
            >
              {short(step.txHash)}
              <IconExternal width={11} height={11} />
            </a>
          ) : (
            <span className="achip__go" title={step.txHash}>
              {short(step.txHash)}
            </span>
          )}
          <CopyButton value={step.txHash} />
        </>
      )}
    </span>
  );
}

function ActivityRow({ item, lit }: { item: ActivityItem; lit: boolean }) {
  return (
    <div
      className={`arow${lit ? ' arow--lit' : ''}`}
      data-testid="activity-row"
      data-activity-id={item.id}
    >
      <div className="arow__head">
        <div className="arow__lead">{item.lead}</div>
        <div className="arow__meta">
          {item.amount != null && <span className="arow__amount mono">{item.amount}</span>}
          <span className={`hstatus hstatus--${item.status.tone}`}>{item.status.label}</span>
          <span className="arow__time">{item.time}</span>
        </div>
      </div>
      {(item.kind || item.fee) && (
        <div className="arow__facts">
          {item.fee && <span className="arow__fee">{item.fee}</span>}
          {/* The kind sits at the end of the line, under the amount and the status
              it belongs with, rather than under the route on the left. */}
          {item.kind && <span className="achip achip--plain arow__kind">{item.kind}</span>}
        </div>
      )}
      {item.note && <div className="arow__note">{item.note}</div>}
      {item.steps.length > 0 && (
        <div className="arow__steps">
          {item.steps.map((s, i) => (
            <StepChip key={`${s.label}-${i}`} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ActivityBlock({
  items,
  labels,
  limit = 5,
  spotlight,
  all,
  ...rest
}: {
  /** Newest first. */
  items: readonly ActivityItem[];
  labels: ActivityLabels;
  limit?: number;
  /**
   * A row this page has just created, to be pointed at once.
   *
   * The screen that starts something knows which row it is; the block does not,
   * and waiting for it to become "attention-worthy" would mean saying nothing at
   * the one moment somebody wants to be told where their transfer went. Pointed at
   * once and then let go: it lights if the block is in view, raises the pill if it
   * is not, and either way it is finished with as soon as it has been followed.
   */
  spotlight?: string | null;
  /**
   * Where the whole list lives, as a link.
   *
   * `All` used to unfold a second copy of that list inside this block: the same
   * rows the reader was already looking at, with a search box and a date filter
   * bolted underneath them. Two lists of one thing on one screen, and the fuller
   * one had a screen of its own the whole time.
   *
   * A link rather than a handler, so it can be middle-clicked into a new tab and
   * copied like any other address. `onNavigate` is only for the plain left click,
   * which stays inside the page.
   */
  all?: { href: string; onNavigate: () => void } | undefined;
} & { [k: `data-${string}`]: string }) {
  const blockRef = useRef<HTMLDivElement | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [lit, setLit] = useState<readonly string[]>([]);
  /**
   * Runs already followed, keyed by the state they were in when they were.
   *
   * The key carries the state on purpose. Dismissing "in progress" should not also
   * dismiss the failure that run turns into ten seconds later, and keying by id
   * alone did exactly that.
   */
  const [seen, setSeen] = useState<readonly string[]>([]);

  const shown = useMemo(() => items.slice(0, limit), [items, limit]);

  /*
   * What the pill is for: rows that need a look, plus the one this page just
   * started. Both are keyed the same way, so following the pill retires the run
   * that raised it without retiring the next thing that goes wrong with it.
   */
  const calling = useMemo(
    () =>
      items.filter((i) => {
        const why = i.id === spotlight ? (i.attention ?? 'new') : i.attention;
        return why && !seen.includes(`${i.id}:${why}`);
      }),
    [items, seen, spotlight],
  );
  const running = calling.filter((i) => i.attention === 'running').length;
  const failed = calling.filter((i) => i.attention === 'failed').length;
  // A row that is neither: the one this page just made, which is finished or
  // waiting and needs no alarm, only pointing at.
  const fresh = calling.length - running - failed;

  /*
   * Whether the block is already where the reader is looking. A pill pointing at
   * something on screen is a pill pointing at nothing.
   *
   * Measured rather than observed. `IntersectionObserver` is the right tool and it
   * was the only one here until a run in a tab that was not in front produced a
   * block a thousand pixels below the fold and no callback at all: the browser
   * stops delivering them while nothing is being painted, so the pill decided the
   * block was visible on the strength of an answer it had never been given. The
   * observer still does the work while the page is being looked at; the measurement
   * is what makes the answer true when it wakes up, and it only runs while there is
   * something worth pointing at.
   */
  const watching = calling.length > 0;
  useEffect(() => {
    const measure = () => {
      const el = blockRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const h = window.innerHeight || document.documentElement.clientHeight;
      setOnScreen(r.top < h - 40 && r.bottom > 40);
    };
    measure();
    if (!watching) return;
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(measure, { rootMargin: '-40px 0px -40px 0px' });
    if (io && blockRef.current) io.observe(blockRef.current);
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    // The list grows and shrinks under the reader without them scrolling, which
    // moves the block without any of the events above firing.
    const timer = setInterval(measure, 700);
    return () => {
      io?.disconnect();
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      clearInterval(timer);
    };
  }, [watching]);

  useEffect(() => {
    if (lit.length === 0) return;
    const timer = setTimeout(() => setLit([]), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [lit]);

  /*
   * A new row that is already in view needs no pill; it just lights.
   *
   * Marked as seen at the same moment, so it does not raise the pill a second
   * later if the reader happens to scroll away from it.
   */
  useEffect(() => {
    if (!spotlight || !onScreen) return;
    // Once. The effect re-runs on every write to the run -- which is every step it
    // reports -- and without this the row lit again on each of them, so a transfer
    // spent its whole life flashing rather than being pointed at once.
    if (seen.includes(`${spotlight}:new`)) return;
    if (!items.some((i) => i.id === spotlight)) return;
    setSeen((prev) => [...prev, `${spotlight}:new`]);
    setLit([spotlight]);
  }, [spotlight, onScreen, items, seen]);

  const jump = useCallback(() => {
    const ids = calling.map((i) => i.id);
    setSeen((prev) => [
      ...prev,
      ...calling.map((i) => `${i.id}:${i.id === spotlight ? (i.attention ?? 'new') : i.attention}`),
    ]);
    setLit(ids);
    // The row itself rather than the block, since the block's title may be the only
    // part that fits on a short screen and the row is what someone was sent to see.
    const first = ids[0];
    // The row itself rather than the block, since the block's title may be the only
    // part that fits on a short screen and the row is what someone was sent to see.
    const row = first
      ? blockRef.current?.querySelector(`[data-activity-id="${CSS.escape(first)}"]`)
      : null;
    const target = row ?? blockRef.current;
    if (!target) return;

    /*
     * Scrolled by arithmetic, with `scrollIntoView` as the nicety rather than the
     * mechanism.
     *
     * A smooth scroll is an animation, and an animation only runs while the page is
     * being painted. Asking for one in a tab that is not in front, or with motion
     * turned down, can leave the page exactly where it was -- which is the one
     * outcome this button must not have, because someone pressed it to be taken
     * somewhere. So the destination is worked out first, the animation is asked for,
     * and if nothing has moved shortly after, the page is simply put there.
     */
    const doc = document.documentElement;
    const rect = target.getBoundingClientRect();
    const h = window.innerHeight || doc.clientHeight;
    const wanted = Math.max(
      0,
      Math.min(
        doc.scrollHeight - h,
        rect.top + window.scrollY - Math.max(24, (h - rect.height) / 2),
      ),
    );
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: wanted, ...(smooth ? { behavior: 'smooth' as const } : {}) });
    const from = window.scrollY;
    setTimeout(() => {
      if (Math.abs(window.scrollY - from) < 8 && Math.abs(window.scrollY - wanted) > 8) {
        window.scrollTo(0, wanted);
      }
    }, 500);
  }, [calling]);

  const pill = !onScreen && calling.length > 0;

  return (
    <>
      {pill && (
        <button
          type="button"
          className={`ajump${failed > 0 ? ' ajump--err' : ''}`}
          onClick={jump}
          aria-label={labels.jump}
          data-testid="activity-jump"
        >
          {failed > 0 ? (
            <span className="ajump__mark" aria-hidden>
              !
            </span>
          ) : running > 0 ? (
            <span className="spinner" style={{ width: 13, height: 13 }} aria-hidden />
          ) : null}
          <span>
            {failed > 0
              ? labels.failed.replace('{n}', String(failed))
              : running > 0
                ? labels.running.replace('{n}', String(running))
                : labels.fresh.replace('{n}', String(fresh))}
          </span>
          <span className="ajump__arrow" aria-hidden>
            &darr;
          </span>
        </button>
      )}

      <div className="ablock" ref={blockRef} {...rest}>
        <div className="ablock__head">
          <span className="ablock__title">{labels.title}</span>
          {/* Offered whenever there is a fuller list to go to, even when the rows
              above already show everything: that screen carries the search and the
              filters, and "there are only four rows today" is not a reason to put
              them out of reach. */}
          {all && (
            <a
              className="ablock__all"
              href={all.href}
              onClick={(e) => {
                // Only the plain click is ours. A middle click, or one with a
                // modifier, is the reader asking for a new tab and the browser
                // does that better than we can.
                if (!isPlainClick(e)) return;
                e.preventDefault();
                all.onNavigate();
              }}
              data-testid="activity-all"
            >
              {labels.all}
            </a>
          )}
        </div>

        {shown.length === 0 ? (
          <p className="hint" data-testid="activity-empty">
            {labels.empty}
          </p>
        ) : (
          <div className="ablock__rows">
            {shown.map((item) => (
              <ActivityRow key={item.id} item={item} lit={lit.includes(item.id)} />
            ))}
          </div>
        )}

      </div>
    </>
  );
}
