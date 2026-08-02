import type { RiskReport } from '@ctrl-arcz/sdk';
import { useI18n } from '../i18n/context.js';
import type { TranslationKey } from '../i18n/en.js';
import { IconShield, IconAlert, IconBlock, IconChevron } from './icons.js';
import { short } from './components.js';

const META: Record<RiskReport['level'], { key: TranslationKey; Icon: typeof IconShield }> = {
  safe: { key: 'risk.safe', Icon: IconShield },
  warning: { key: 'risk.warning', Icon: IconAlert },
  block: { key: 'risk.block', Icon: IconBlock },
};

/**
 * @param collapsed Hides the reason list, never the verdict. A verdict the user
 *   can fold away entirely is a verdict they can miss, so the headline and its
 *   colour always stay on screen; only the explanation folds.
 * @param onToggle Omit to render with no control at all.
 */
export function RiskCard({
  report,
  collapsed = false,
  onToggle,
}: {
  report: RiskReport;
  collapsed?: boolean;
  onToggle?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const { key, Icon } = META[report.level];
  const hasDetail = report.reasons.length > 0;

  return (
    <div
      className={`risk risk--${report.level}${report.level === 'block' ? ' marked' : ''}`}
      data-testid="risk-card"
      data-level={report.level}
    >
      <div className="risk__head">
        <Icon width={18} height={18} />
        {t(key)}
        {onToggle && hasDetail && (
          <button
            type="button"
            className={`risk__toggle${collapsed ? '' : ' is-open'}`}
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
      {!collapsed && hasDetail && (
        <ul className="risk__reasons">
          {report.reasons.map((r) => {
            const reasonKey = `risk.reason.${r.code}` as TranslationKey;
            const translated = t(reasonKey, {
              addr: r.lookalikeOf ? short(r.lookalikeOf) : '',
              count: r.count ?? 0,
              sources: (r.sources ?? []).join(', '),
            });
            // Fall back to the SDK's English message for any code without a key.
            const text = translated === reasonKey ? r.message : translated;
            // Colour each line by its OWN severity, not the card's. A blocked verdict
            // usually carries a mix, and reading "no on-chain history" in the same red
            // as the rule that actually stopped the send hides which one did.
            return (
              <li key={r.code} className={`risk__reason risk__reason--${r.severity}`}>
                {text}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
