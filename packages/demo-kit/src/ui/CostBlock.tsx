import type { ReactNode } from 'react';

/** One line of a {@link CostBlock}: what it is on the left, what it comes to on the right. */
export type CostLine = {
  label: ReactNode;
  value: ReactNode;
  /** Hook for a test that needs this particular figure rather than the block. */
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
  if (lines.length === 0 && !total) return null;
  return (
    <div className={`cost ${warning ? 'cost--warn' : ''}`} data-testid={testId}>
      {lines.map((line, i) => (
        <div className="cost__row" key={i}>
          <span className="cost__k">{line.label}</span>
          <span className="cost__v" data-testid={line.testId}>
            {line.value}
          </span>
        </div>
      ))}
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
