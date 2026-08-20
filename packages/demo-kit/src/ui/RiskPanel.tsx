import type { ReactNode, RefObject } from 'react';
import { IconAlert, IconBlock, IconChevron, IconShield } from './icons.js';
import { useT } from '../i18n/context.js';
import { readReserved, useRecordHeight } from './reservedHeight.js';

export type CheckState = 'running' | 'done' | 'unavailable';
/** What this source itself concluded, which is not always what the card says. */
export type CheckTone = 'neutral' | 'safe' | 'warning' | 'block';
export type PanelLevel = 'pending' | 'safe' | 'warning' | 'block';

export interface PanelCheck {
  /** What this check is called, in the user's words. */
  name: ReactNode;
  state: CheckState;
  /**
   * This row's own severity, not the card's.
   *
   * A blocked verdict usually comes from one source while the other found nothing,
   * and colouring both dots by the card made the clean one look like it had
   * objected too. The reasons list has always been coloured this way; the rows
   * above it now are as well.
   */
  tone?: CheckTone;
  /** One line: the answer. Absent while running. */
  result?: ReactNode;
  /** The reasoning, shown when the panel is expanded. */
  detail?: ReactNode;
  /**
   * Hold this row's last height open while it is still running.
   *
   * "Nothing moves except the text inside them" was true of a row whose answer is
   * a few words. It is not true of the agent's, which arrives as a headline and up
   * to four bullets and pushes the rest of the form down the page at the exact
   * moment somebody is reading it. What the row will be is unknowable before the
   * answer, but what it was last time is a good guess at it, so the space is held
   * from the start and the answer lands in it.
   */
  reserveId?: string;
}

/**
 * The firewall's verdict on one address: one card, two sources.
 *
 * It used to be a sequence. A bare 56px grey bar with no words while the rules
 * ran, then a verdict card, then a second block underneath saying the deep check
 * was running, then that block vanishing when the answer came back clean. Four
 * states, the card measured at 588, 656, 781 and 694px, two different loading
 * shapes one after the other, and a check that finished by disappearing.
 *
 * None of that is two things happening. It is one question, "is this address
 * safe to pay", answered by two sources that arrive at different times. So it is
 * one card with a row per source, present from the moment the address is valid,
 * every row visible in every state. The rows do not appear and disappear; they
 * fill in. Nothing moves except the text inside them.
 *
 * The headline carries the strongest verdict so far and never softens: a source
 * that has not answered cannot make a block look like a warning, and while
 * anything is still running the headline says so rather than showing a green tick
 * the next row is about to contradict.
 */
export function RiskPanel({
  level,
  headline,
  checks,
  collapsed = false,
  onToggle,
  footer,
  'data-testid': testId,
}: {
  level: PanelLevel;
  headline: ReactNode;
  checks: PanelCheck[];
  collapsed?: boolean;
  onToggle?: (() => void) | undefined;
  /** The override hatch, under a refusal. Part of the card, not a fifth box. */
  footer?: ReactNode;
  'data-testid'?: string;
}) {
  const t = useT();
  const Icon = level === 'block' ? IconBlock : level === 'warning' ? IconAlert : IconShield;
  const hasDetail = checks.some((c) => c.detail);

  return (
    <div
      className={`riskp riskp--${level}${level === 'block' ? ' marked' : ''}`}
      data-testid={testId}
      data-level={level}
    >
      <div className="riskp__head">
        {level === 'pending' ? (
          <span className="riskp__spin" aria-hidden />
        ) : (
          <Icon width={18} height={18} />
        )}
        <strong className="riskp__headline">{headline}</strong>
        {onToggle && hasDetail && (
          <button
            type="button"
            className={`riskp__toggle${collapsed ? '' : ' is-open'}`}
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'risk.show' : 'risk.hide')}
            title={t(collapsed ? 'risk.show' : 'risk.hide')}
            data-testid="risk-toggle"
          >
            <IconChevron width={15} height={15} />
          </button>
        )}
      </div>

      <ul className="riskp__checks">
        {checks.map((c, i) => (
          <CheckRow key={i} check={c} index={i} collapsed={collapsed} />
        ))}
      </ul>

      {footer}
    </div>
  );
}

/**
 * One source's row.
 *
 * Its own component so it can hold a hook: the height it settles at is recorded
 * when the answer is in, and read back as a floor while the next one is still
 * out. Recording is switched off while the row is running, or the row would teach
 * the reserve its own empty height and the space would never be held again.
 */
function CheckRow({
  check,
  index,
  collapsed,
}: {
  check: PanelCheck;
  index: number;
  collapsed: boolean;
}) {
  const t = useT();
  const running = check.state === 'running';
  const ref = useRecordHeight(running ? undefined : check.reserveId);
  const reserved = running && check.reserveId ? readReserved(check.reserveId) : null;

  return (
    <li
      ref={ref as RefObject<HTMLLIElement>}
      className={`riskp__check riskp__check--${check.state} riskp__check--tone-${check.tone ?? 'neutral'}`}
      data-check={index}
      {...(reserved ? { style: { minHeight: reserved } } : {})}
    >
      <span className="riskp__mark" aria-hidden />
      <span className="riskp__name">{check.name}</span>
      <span className="riskp__result">{running ? t('risk.checkRunning') : check.result}</span>
      {!collapsed && check.detail && <div className="riskp__detail">{check.detail}</div>}
    </li>
  );
}
