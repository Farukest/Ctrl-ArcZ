import { useState, type ReactNode } from 'react';

/** One line of a {@link CostBlock}: what it is on the left, what it comes to on the right. */
export type CostLine = {
  label: ReactNode;
  value: ReactNode;
  /** Hook for a test that needs this particular figure rather than the block. */
  testId?: string;
  /**
   * What this line is made of, revealed on request. Absent means it is not
   * divisible and the row is plain text rather than a control.
   *
   * A Gateway fee is the sum of a base fee per network plus one forwarding fee,
   * and those numbers differ by a factor of a thousand: a split across Ethereum
   * and Unichain came to 1.017, of which Unichain was 0.001. Totalled, that reads
   * as an expensive transfer with no way to see which network made it one. It is
   * still a total by default, because most transfers touch one network and a fee
   * that unfolds every time is a fee that asks to be read every time.
   */
  breakdown?: CostBreakdown[];
};

/** One component of a divisible cost, with room for a logo in the label. */
export type CostBreakdown = {
  label: ReactNode;
  value: ReactNode;
  testId?: string;
};

export type CostBlockProps = {
  /** The costs, stated quietly. */
  lines: CostLine[];
  /** What actually leaves the wallet. Absent until there is an amount to total up. */
  total?: CostLine | null;
  /**
   * A cost that is a reason to do something else, not one that is merely disliked.
   * Turns the outline and the figures amber and prints the sentence underneath.
   */
  warning?: string | null;
  testId?: string;
};

/**
 * What this is going to cost, before it is agreed to.
 *
 * The bridge had the only copy, and it earned its place there: the fee is not small,
 * it depends on the route rather than the amount, and finding it out from the
 * balance afterwards is not an acceptable way to learn it. Nothing about that
 * argument is specific to bridging. Sending said what it would cost nowhere at all,
 * and on Arc gas is USDC out of the same balance as the transfer, so every one of
 * those screens was showing the smaller of the two figures that leave the wallet.
 *
 * Two parts on purpose. {@link CostBlockProps.lines} are the costs; {@link
 * CostBlockProps.total} is what is actually being paid, below a divider and at a
 * heavier weight, because "what does this cost" and "what am I paying" are two
 * answers and stacked as equals they read as one list nobody finishes.
 *
 * Raised off the background and outlined, because at the weight of the rest of a
 * form the number that decides whether something is worth doing read as a footnote
 * under the button.
 *
 * The lines have to add up to the total. That sounds obvious and it is the one rule
 * this component cannot enforce for its callers: a block whose parts do not sum to
 * its own bottom line is worse than no block, because it invites the arithmetic and
 * then fails it. Where a figure is a ceiling rather than a price, the ceiling is
 * what goes in both places and the label says so.
 */
export function CostBlock({ lines, total = null, warning = null, testId }: CostBlockProps) {
  // Which divisible lines are open, by index. Local because it is a way of looking
  // at the block rather than anything the form is holding.
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  if (lines.length === 0 && !total) return null;
  return (
    <div className={`cost ${warning ? 'cost--warn' : ''}`} data-testid={testId}>
      {lines.map((line, i) => {
        const parts = line.breakdown ?? [];
        if (parts.length === 0) {
          return (
            <div className="cost__row" key={i}>
              <span className="cost__k">{line.label}</span>
              <span className="cost__v" data-testid={line.testId}>
                {line.value}
              </span>
            </div>
          );
        }
        const shown = open.has(i);
        return (
          <div className="cost__group" key={i}>
            {/* The whole row is the control, not a separate caret: a figure with a
                disclosure beside it invites two guesses about what is pressable. */}
            <button
              type="button"
              className="cost__row cost__row--open"
              aria-expanded={shown}
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(i)) next.add(i);
                  return next;
                })
              }
              data-testid={line.testId ? `${line.testId}-toggle` : undefined}
            >
              <span className="cost__k">
                {line.label}
                {/* Drawn in CSS rather than set as a character: at this size the
                    glyphs for a chevron render as a smudge, and which smudge you
                    get depends on the font that resolved. */}
                <span className={`cost__caret ${shown ? 'cost__caret--up' : ''}`} aria-hidden />
              </span>
              <span className="cost__v" data-testid={line.testId}>
                {line.value}
              </span>
            </button>
            {shown && (
              <div className="cost__break" data-testid={line.testId ? `${line.testId}-break` : undefined}>
                {parts.map((p, j) => (
                  <div className="cost__brow" key={j}>
                    <span className="cost__bk">{p.label}</span>
                    <span className="cost__bv" data-testid={p.testId}>
                      {p.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {total && (
        <>
          <div className="cost__sep" />
          <div className="cost__row">
            <span className="cost__k">{total.label}</span>
            <span className="cost__v cost__v--big" data-testid={total.testId}>
              {total.value}
            </span>
          </div>
        </>
      )}
      {warning && <p className="cost__warn">{warning}</p>}
    </div>
  );
}
