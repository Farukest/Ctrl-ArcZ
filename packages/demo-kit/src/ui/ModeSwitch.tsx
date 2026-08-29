import { IconArrowDownLeft, IconArrowUpRight } from './icons.js';
import { useT } from '../i18n/context.js';
import { isPlainClick } from '../isPlainClick.js';

export type Mode = 'send' | 'receive';

/**
 * The app's primary control: two worlds, Send and Receive, as one hero switch at the
 * very top. Switching morphs the whole view (see .mode-view) so it reads as moving to
 * a different space, without a route change. A waiting claim badges the "Receive"
 * half even while the user is standing on "Send".
 *
 * It is the same segmented control as `.segtabs`, one size up: same sunken track,
 * same keycap radius ladder, same single accent. Direction is carried by the arrow
 * pair, not by a second and third brand color. Two saturated hues here would also
 * have spent the palette's green, and on a product whose whole job is to say
 * "this address is safe" green has to keep meaning exactly that.
 */
export function ModeSwitch({
  mode,
  onChange,
  pendingCount,
  hrefFor,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  pendingCount: number;
  /** The address of each half, so it can be middle-clicked and linked to. */
  hrefFor?: ((m: Mode) => string) | undefined;
}) {
  const t = useT();
  const go = (m: Mode) => (e: React.MouseEvent) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    onChange(m);
  };
  /** Same control either way; a link when there is an address for it. */
  const half = (m: Mode, children: React.ReactNode) =>
    hrefFor ? (
      <a
        role="tab"
        aria-selected={mode === m}
        className="modeswitch__btn"
        href={hrefFor(m)}
        onClick={go(m)}
        data-testid={`mode-${m}`}
      >
        {children}
      </a>
    ) : (
      <button
        type="button"
        role="tab"
        aria-selected={mode === m}
        className="modeswitch__btn"
        onClick={() => onChange(m)}
        data-testid={`mode-${m}`}
      >
        {children}
      </button>
    );
  return (
    <div className="modeswitch" role="tablist" data-mode={mode} aria-label="Send or Receive">
      <span className="modeswitch__thumb" aria-hidden />
      {half(
        'send',
        <>
          <IconArrowUpRight width={15} height={15} aria-hidden />
          {t('mode.send')}
        </>,
      )}
      {half(
        'receive',
        <>
          <IconArrowDownLeft width={15} height={15} aria-hidden />
          {t('mode.receive')}
          {pendingCount > 0 && (
            // Keyed on the count so the attention pulse replays when a new payment
            // lands, instead of running once at mount and never again.
            <span
              key={pendingCount}
              className="modeswitch__dot"
              aria-label={`${pendingCount} waiting`}
            >
              {pendingCount}
            </span>
          )}
        </>,
      )}
    </div>
  );
}
