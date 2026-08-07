import type { ReactNode } from 'react';
import { CopyButton, short } from './components.js';
import { IconExternal } from './icons.js';

/**
 * One vocabulary for every row in every history.
 *
 * Each screen used to assemble its own row out of its own class names, and they
 * diverged in the ways copies do: the bridge showed a route and no recipient, the
 * transfer list showed an id and no steps, and only some of the values you would
 * ever want to paste somewhere had a copy button. A row is the same idea in all of
 * them, so it is one component with named parts, and a screen chooses which parts
 * it has rather than how a row is built.
 *
 * The rule that drove the shape: anything that is data rather than prose is
 * copyable. An address, a transaction, an id, a claim code. If a value would be
 * useless to a person unless they could paste it somewhere else, it carries its own
 * copy button, and no screen has to remember to add one.
 */

/** A single stage of something that happened in steps. */
export interface RowStep {
  /** Already translated. This component does no lookups. */
  label: string;
  txHash?: string | undefined;
  explorerUrl?: string | undefined;
  /** `error` marks the step that failed; everything before it is assumed done. */
  state?: 'done' | 'error' | undefined;
}

export type RowTone = 'ok' | 'warn' | 'err' | 'idle';

export function HistoryRow({
  children,
  ...rest
}: { children: ReactNode } & Record<string, unknown>) {
  return (
    <div className="hrow trow" {...rest}>
      {children}
    </div>
  );
}

/**
 * The line you read first: what happened, to what, for how much, and when.
 *
 * `lead` is the identity of the row and differs per screen (a route, a name, an
 * address). Everything else is in the same place every time, which is what lets
 * someone scan four different histories without relearning the layout.
 */
HistoryRow.Head = function Head({
  lead,
  amount,
  status,
  time,
}: {
  lead: ReactNode;
  amount?: ReactNode;
  status?: { tone: RowTone; label: string } | undefined;
  time?: string | undefined;
}) {
  return (
    <div className="hrow__head">
      <div className="hrow__lead">{lead}</div>
      <div className="hrow__meta">
        {amount != null && <span className="hrow__amount mono">{amount}</span>}
        {status && <span className={`hstatus hstatus--${status.tone}`}>{status.label}</span>}
        {time && <span className="hrow__time">{time}</span>}
      </div>
    </div>
  );
};

/** Label and value pairs. Use `Fact` for prose, `Address`/`Copyable` for data. */
HistoryRow.Facts = function Facts({ children }: { children: ReactNode }) {
  return <div className="hrow__facts">{children}</div>;
};

HistoryRow.Fact = function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hrow__fact">
      <span className="hrow__factk">{label}</span>
      <span className="hrow__factv">{children}</span>
    </div>
  );
};

/**
 * The steps, in order, each carrying its transaction where it has one.
 *
 * A step without a hash is still shown: knowing that the attestation happened is
 * part of understanding the row, even though there is nothing to link to. A step
 * with one is a link and a copy, because a transaction hash is the single most
 * likely thing to be pasted into a block explorer or a support message.
 */
HistoryRow.Steps = function Steps({ steps }: { steps: readonly RowStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="hrow__steps">
      {steps.map((s, i) => (
        <span
          key={`${s.label}-${i}`}
          className={`hstep${s.state === 'error' ? ' hstep--err' : ''}${s.txHash ? '' : ' hstep--bare'}`}
        >
          <span className="hstep__name">{s.label}</span>
          {s.txHash && (
            <>
              {isHttps(s.explorerUrl) ? (
                <a
                  className="hstep__go"
                  href={s.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={s.txHash}
                >
                  {short(s.txHash)}
                  <IconExternal width={12} height={12} />
                </a>
              ) : (
                <span className="hstep__go" title={s.txHash}>
                  {short(s.txHash)}
                </span>
              )}
              <CopyButton value={s.txHash} />
            </>
          )}
        </span>
      ))}
    </div>
  );
};

HistoryRow.Actions = function Actions({ children }: { children: ReactNode }) {
  return <div className="hrow__actions">{children}</div>;
};

/**
 * Any value worth pasting elsewhere.
 *
 * Shows a shortened form and copies the whole thing, which is almost always what is
 * wanted: the short form is for recognising, the clipboard is for using.
 */
export function Copyable({
  value,
  display,
  mono = true,
}: {
  value: string;
  display?: ReactNode;
  mono?: boolean;
}) {
  return (
    <span className={`copyable${mono ? ' mono' : ''}`} title={value}>
      <span className="copyable__text">{display ?? value}</span>
      <CopyButton value={value} />
    </span>
  );
}

/** An address, shortened, always copyable in full. */
export function Address({ address, full = false }: { address: string; full?: boolean }) {
  return <Copyable value={address} display={full ? address : short(address)} />;
}

/**
 * Only render https links. These values are read back from storage, and a tampered
 * entry could otherwise carry a `javascript:` URL that runs in this origin.
 */
function isHttps(url?: string): boolean {
  return Boolean(url && /^https:\/\//i.test(url));
}
