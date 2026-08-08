import { RiskCard, Skeleton, IconChevron, useT } from '@ctrl-arcz/demo-kit/ui';
import type { RecipientGate } from '../lib/useRecipientGate.js';
import { RiskOverride } from './RiskOverride.js';

/**
 * Everything the firewall has to say about the address in the box, drawn the same
 * way on every screen that has one.
 *
 * This lived inside the send screen. The bridge grew a recipient field and copied
 * half of it: the rule card came across, the investigator's second opinion did
 * not. So the bridge could block on an advisory it never showed the user, which
 * is the worst version of a refusal -- one with no reason attached. Private Pay
 * and Subscriptions copied none of it and only learned the verdict from the
 * server after the button was pressed.
 *
 * Three states, in the order they arrive: the rules are running, the rules have
 * answered, the investigator has answered. The pending line between the last two
 * matters more than it looks: without it the advisory box simply materialised a
 * few seconds later and read as a glitch.
 */
export function RiskGate({
  gate,
  recoverable = true,
  overridable = true,
  'data-testid': testId,
}: {
  gate: RecipientGate;
  /**
   * Whether this path can be undone. A protected transfer can be cancelled and
   * expires back to the sender; a bridge or a private payment cannot. The escape
   * hatch says so, because "you can still take it back" is the reason overriding
   * is tolerable and it is not true everywhere.
   */
  recoverable?: boolean;
  /**
   * Whether this screen can actually deliver an override.
   *
   * Private Pay and Subscriptions are gated a second time by the co-signer, which
   * runs the same firewall on the server and vetoes a bad merchant there. This
   * client cannot speak for that decision, so offering the escape hatch would arm
   * a button that then fails at the server, which is worse than a button that
   * stays shut. Those screens pass false until the co-signer has a channel for
   * acknowledgements of its own.
   */
  overridable?: boolean;
  'data-testid'?: string;
}) {
  const t = useT();
  const { checking, activeReport, investigating, advisory } = gate;

  if (checking) {
    return (
      <div style={{ marginTop: 12 }} data-testid={testId ? `${testId}-checking` : undefined}>
        <Skeleton height={56} />
      </div>
    );
  }
  if (!activeReport) return null;

  return (
    <div data-testid={testId}>
      <div style={{ marginTop: 12 }}>
        <RiskCard
          report={activeReport}
          collapsed={!gate.ruleOpen}
          onToggle={() => gate.setRuleOpen(!gate.ruleOpen)}
        />
        {/* Only under a refusal. A warning already lets the send through, so
            offering an override there would be a second button for something
            that is not stopped. */}
        {gate.blocked && overridable && (
          <RiskOverride
            report={activeReport}
            recoverable={recoverable}
            onAcknowledge={gate.acknowledge}
            onCancel={gate.clearAcknowledgement}
          />
        )}
      </div>

      {investigating && !advisory && (
        <div style={{ marginTop: 10 }} data-testid="advisory-pending">
          <p className="muted" style={{ marginBottom: 6 }}>
            {t('risk.investigating')}
          </p>
          <Skeleton height={48} />
        </div>
      )}

      {advisory && (
        <div
          className={`risk risk--${advisory.level === 'safe' ? 'safe' : advisory.level === 'block' ? 'block' : 'warn'}`}
          style={{ marginTop: 10 }}
          data-testid="advisory"
        >
          <div className="risk__head">
            <strong>{advisory.headline}</strong>
            {advisory.points.length > 0 && (
              <button
                type="button"
                className={`risk__toggle${gate.advisoryOpen ? ' is-open' : ''}`}
                onClick={() => gate.setAdvisoryOpen(!gate.advisoryOpen)}
                aria-expanded={gate.advisoryOpen}
                aria-label={t(gate.advisoryOpen ? 'risk.hide' : 'risk.show')}
                title={t(gate.advisoryOpen ? 'risk.hide' : 'risk.show')}
                data-testid="advisory-toggle"
              >
                <IconChevron width={15} height={15} />
              </button>
            )}
          </div>
          {gate.advisoryOpen && advisory.points.length > 0 && (
            <ul>
              {advisory.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
