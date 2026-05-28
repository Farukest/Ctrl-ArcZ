import type { ReactNode } from 'react';
import { IconCheck } from './icons.js';

export interface Step {
  label: ReactNode;
  status: 'pending' | 'active' | 'done';
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
