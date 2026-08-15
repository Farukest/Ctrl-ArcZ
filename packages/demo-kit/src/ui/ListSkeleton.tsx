import { Skeleton } from './components.js';
import { readReserved } from './reservedHeight.js';

/**
 * The loading state for a `HistoryList`, shaped like the list it becomes.
 *
 * Every list screen was reserving a token 48px or 72px while it read the chain and
 * then expanding to its real size in one frame. Measured: the subscriptions card
 * went 115px to 1303px, the history card 146px to 951px. Nothing slid sideways, so
 * CLS stayed near zero and the automated check said nothing, but the page changed
 * length under the reader, which is the jump they actually see.
 *
 * So this mirrors what `HistoryList` renders: the controls row, the optional filter
 * chips, `rows` rows at the height that screen's rows really are, the day headings
 * between them, and the pager. Dimensions come from measuring the loaded lists, not
 * from taste, and they are named below so a layout change can be traced back here.
 *
 * The remaining error is a few tens of pixels rather than a thousand: the number of
 * day headings depends on data nobody has yet, so one per three rows is assumed.
 */

/** Search + date select. Both 40px tall, on one line until they wrap. */
const CONTROLS_H = 40;
/** `.sub-chips`, when a screen carries status chips. */
const CHIPS_H = 62;
/** Gap between rows, from `.hrow + .hrow`. */
const ROW_GAP = 12;
/** A day heading with its margins. */
const HEADING_H = 22;
/** `.pagination`. */
const PAGER_H = 34;

export interface ListSkeletonProps {
  /** How many rows to reserve. Pass the screen's own page size. */
  rows?: number;
  /**
   * The real height of one row on this screen, measured: 105 for the transfer
   * history, 151 for active transfers, 180 for a subscription.
   */
  rowHeight: number;
  /** Reserve the status-chip row, for lists that have one. */
  chips?: boolean;
  /** Reserve the pager. Off for lists that never page. */
  pager?: boolean;
  /**
   * Matches this placeholder to the list it stands in for, so it can be exactly as
   * tall as that list was last time. Without it the row model is used, which is
   * close but never right: see reservedHeight.ts.
   */
  reserveId?: string;
}

export function ListSkeleton({
  rows = 5,
  rowHeight,
  chips = false,
  pager = true,
  reserveId,
}: ListSkeletonProps) {
  // What this list actually settled at last time beats any model of it. The rows
  // below still render, clipped to that height, so the placeholder looks like a
  // list rather than one tall grey slab.
  const remembered = reserveId ? readReserved(reserveId) : null;
  // Enough rows to fill a remembered height, so a tall reservation is not mostly
  // empty. Clipping makes an overshoot harmless.
  const shown = remembered
    ? Math.max(rows, Math.ceil(remembered / (rowHeight + ROW_GAP)))
    : rows;
  // One heading per three rows, the way a few days of activity usually groups.
  const groups = Math.max(1, Math.ceil(shown / 3));
  const perGroup = Math.ceil(shown / groups);

  return (
    <div
      className="listskel"
      aria-busy="true"
      data-testid="list-skeleton"
      style={remembered ? { height: remembered, overflow: 'hidden' } : undefined}
    >
      <div className="hist-controls">
        <Skeleton height={CONTROLS_H} />
        <Skeleton width={132} height={CONTROLS_H} />
      </div>

      {chips && (
        <div className="listskel__chips" style={{ height: CHIPS_H }}>
          {[64, 84, 78, 96, 82].map((w, i) => (
            <Skeleton key={i} width={w} height={30} />
          ))}
        </div>
      )}

      <div className="listskel__rows" style={{ gap: ROW_GAP }}>
        {Array.from({ length: groups }, (_, g) => (
          <div key={g} className="listskel__group" style={{ gap: ROW_GAP }}>
            <Skeleton width={88} height={HEADING_H} />
            {Array.from({ length: Math.min(perGroup, shown - g * perGroup) }, (_, r) => (
              <Skeleton key={r} height={rowHeight} />
            ))}
          </div>
        ))}
      </div>

      {pager && (
        <div className="listskel__pager">
          <Skeleton width={188} height={PAGER_H} />
        </div>
      )}
    </div>
  );
}
