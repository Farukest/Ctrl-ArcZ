import type { ReactNode } from 'react';
import { IconCheck } from './icons.js';

/**
 * `skipped` and `error` are here because callers were already passing them.
 * BridgeTab produced an `error` status and cast the array to `Step[]` to get it
 * past the type checker, and there was no rule for `step--error`, so a failed step
 * rendered as a grey number: identical to a step that had not started. A status the
 * indicator cannot express is a status the indicator gets wrong.
 */
export interface Step {
  label: ReactNode;
  status: 'pending' | 'active' | 'done' | 'skipped' | 'error';
}

/** Vertical step indicator for multi-tx flows (approve then sign then send). */
export function Stepper({
  steps,
  highlightIndex = null,
}: {
  steps: Step[];
  highlightIndex?: number | null;
}) {
  return (
    <div className="steps" data-testid="stepper">
      {steps.map((s, i) => (
        <div
          key={i}
          className={`step step--${s.status}${i === highlightIndex ? ' step--highlight' : ''}`}
        >
          <span className="step__dot">
            {s.status === 'done' ? (
              <IconCheck width={12} height={12} />
            ) : s.status === 'active' ? (
              <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden />
            ) : s.status === 'error' ? (
              <span style={{ fontSize: 12 }}>!</span>
            ) : s.status === 'skipped' ? (
              // Not a tick and not a number: a step that did not need to happen is
              // neither done nor waiting, and the dash is the only mark that says so.
              <span style={{ fontSize: 11 }}>-</span>
            ) : (
              <span style={{ fontSize: 11 }}>{i + 1}</span>
            )}
          </span>
          {s.label}
        </div>
      ))}
    </div>
  );
}
