import type { ReactNode } from 'react';

/**
 * A short statement about the state of a form, with the button that answers it.
 *
 * These used to be bare paragraphs. "Still 44.055 USDC short of this transfer."
 * sat under a card at body weight with nothing around it, reading as leftover
 * copy rather than as the screen telling you something, and the fix for it lived
 * somewhere else entirely.
 *
 * So a notice is a container with three parts and no essay: a dot in the tone's
 * colour, one line, and optionally the action that resolves it. The dot rather
 * than a filled badge is the house rule: a solid colour block beside a sentence
 * reads as decoration, and this is not decoration.
 *
 * Deliberately not a toast and not an error field. A toast is for something that
 * happened; this is for something that is true right now and stops being true
 * when the form changes.
 */
export type NoticeTone = 'warn' | 'info' | 'ok';

export interface NoticeProps {
  children: ReactNode;
  /** `warn` is amber, `ok` green, `info` quiet. Nothing here is ever red: these
   *  are states of a form being filled in, not failures. */
  tone?: NoticeTone;
  /**
   * The way out, where there is one.
   *
   * A notice that names a problem and leaves the user to find the control is most
   * of the way to not having said it. If the sentence is "you are 3 USDC short",
   * the button beside it is what covers the 3.
   */
  action?: { label: ReactNode; onClick: () => void; testId?: string } | null;
  testId?: string;
}

export function Notice({ children, tone = 'warn', action = null, testId }: NoticeProps) {
  return (
    <div className={`notice notice--${tone}`} data-testid={testId}>
      <span className="notice__dot" aria-hidden />
      <span className="notice__text">{children}</span>
      {action && (
        <button
          type="button"
          className="notice__act"
          onClick={action.onClick}
          data-testid={action.testId}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
