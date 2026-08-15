import { IconArrowDownLeft, IconArrowUpRight } from './icons.js';
import { useT } from '../i18n/context.js';

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
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  pendingCount: number;
}) {
  const t = useT();
  return (
    <div className="modeswitch" role="tablist" data-mode={mode} aria-label="Send or Receive">
      <span className="modeswitch__thumb" aria-hidden />
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'send'}
        className="modeswitch__btn"
        onClick={() => onChange('send')}
        data-testid="mode-send"
      >
        <IconArrowUpRight width={15} height={15} aria-hidden />
        {t('mode.send')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'receive'}
        className="modeswitch__btn"
        onClick={() => onChange('receive')}
        data-testid="mode-receive"
      >
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
      </button>
    </div>
  );
}
