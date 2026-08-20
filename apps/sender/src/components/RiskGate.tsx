import { RiskPanel, short, useT, type PanelCheck, type PanelLevel } from '@ctrl-arcz/demo-kit/ui';
import type { TranslationKey } from '@ctrl-arcz/demo-kit/ui';
import type { RecipientGate } from '../lib/useRecipientGate.js';
import { RiskOverride } from './RiskOverride.js';

/**
 * Everything the firewall has to say about the address in the box, drawn the same
 * way on every screen that has one.
 *
 * This lived inside the send screen. The bridge grew a recipient field and copied
 * half of it: the rule card came across, the investigator's second opinion did
 * not. So the bridge could block on an advisory it never showed the user, which
 * is the worst version of a refusal, one with no reason attached. Private Pay and
 * Subscriptions copied none of it and only learned the verdict from the server
 * after the button was pressed.
 *
 * One card, one row per source. Both rows exist from the moment the address is
 * valid, so the panel fills in rather than growing a box at a time: measured, the
 * old sequence took the send card through 588, 656, 781 and 694px, and the deep
 * check ended by disappearing when it had nothing to add.
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
  const { checking, activeReport, investigating, investigation, idle } = gate;

  // Nothing in the box worth judging: the screen's own validation covers that.
  if (idle && !activeReport) return null;
  if (!checking && !activeReport) return null;

  const rules: PanelCheck = activeReport
    ? {
        name: t('risk.checkRules'),
        state: 'done',
        tone: activeReport.level,
        // What this source found, never the verdict word. The headline already
        // says "Send blocked"; a row underneath repeating it is the same sentence
        // twice, and the useful fact is how many things matched.
        result:
          activeReport.reasons.length === 0
            ? t('risk.rulePassed')
            : t(activeReport.reasons.length === 1 ? 'risk.ruleFinding' : 'risk.ruleFindings', {
                count: activeReport.reasons.length,
              }),
        detail: activeReport.reasons.length > 0 && (
          <ul>
            {activeReport.reasons.map((r) => {
              const key = `risk.reason.${r.code}` as TranslationKey;
              const translated = t(key, {
                addr: r.lookalikeOf ? short(r.lookalikeOf) : '',
                count: r.count ?? 0,
                sources: (r.sources ?? []).join(', '),
              });
              return (
                <li key={r.code} className={`risk__reason risk__reason--${r.severity}`}>
                  {translated === key ? r.message : translated}
                </li>
              );
            })}
          </ul>
        ),
      }
    : { name: t('risk.checkRules'), state: 'running' };

  // Three outcomes, all of them stated. "Found nothing" was previously rendered
  // as the block disappearing, which reads as the check never having run.
  const deep: PanelCheck = investigating
    ? { name: t('risk.checkDeep'), reserveId: 'risk-agent', state: 'running' }
    : investigation?.status === 'advisory'
      ? {
          name: t('risk.checkDeep'),
          reserveId: 'risk-agent',
          state: 'done',
          tone: investigation.advisory.level,
          result: investigation.advisory.headline,
          detail: investigation.advisory.points.length > 0 && (
            <ul>
              {investigation.advisory.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ),
        }
      : investigation?.status === 'clear'
        ? {
            name: t('risk.checkDeep'),
            reserveId: 'risk-agent',
            state: 'done',
            tone: 'safe',
            result: t('risk.deepClear'),
          }
        : investigation?.status === 'unavailable'
          ? {
              name: t('risk.checkDeep'),
              reserveId: 'risk-agent',
              state: 'unavailable',
              // Which gap it is. "Not configured here" is the one every local
              // checkout hits, and reading it as "could not be reached" sends
              // somebody looking for a network fault that is not there.
              result: t(
                investigation.why === 'off'
                  ? 'risk.deepOff'
                  : investigation.why === 'budget'
                    ? 'risk.deepBudget'
                    : 'risk.deepUnavailable',
              ),
            }
          : { name: t('risk.checkDeep'), reserveId: 'risk-agent', state: 'running' };

  // Never softer than what is known, and never green while something is still out.
  const level: PanelLevel = gate.blocked
    ? 'block'
    : checking || investigating
      ? 'pending'
      : (gate.level ?? 'pending');

  const headline =
    level === 'pending' ? t('risk.checkingAddress') : t(`risk.${level}` as TranslationKey);

  return (
    <div style={{ marginTop: 12 }} data-testid={testId}>
      <RiskPanel
        level={level}
        headline={headline}
        checks={[rules, deep]}
        collapsed={!gate.ruleOpen}
        onToggle={() => gate.setRuleOpen(!gate.ruleOpen)}
        data-testid="risk-card"
        footer={
          // Only under a refusal. A warning already lets the send through, so
          // offering an override there would be a second button for something
          // that is not stopped.
          gate.blocked && overridable && activeReport ? (
            <RiskOverride
              report={activeReport}
              recoverable={recoverable}
              onAcknowledge={gate.acknowledge}
              onCancel={gate.clearAcknowledgement}
            />
          ) : null
        }
      />
    </div>
  );
}
