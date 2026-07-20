import { useT } from '@ctrl-arcz/demo-kit/ui';

export type Mode = 'send' | 'receive';

/**
 * The app's primary control: two worlds, Send and Receive, as one hero switch at the
 * very top. Switching morphs the whole view (see app.css transition) so it reads as
 * moving to a different space, without a route change. A waiting claim badges the
 * "Receive" half even while the user is on "Send".
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
        {t('mode.receive')}
        {pendingCount > 0 && (
          <span className="modeswitch__dot" aria-label={`${pendingCount} waiting`}>
            {pendingCount}
          </span>
        )}
      </button>
    </div>
  );
}
