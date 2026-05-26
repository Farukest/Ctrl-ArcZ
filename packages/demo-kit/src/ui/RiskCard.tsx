import type { RiskReport } from '@ctrl-arcz/sdk';
import { useI18n } from '../i18n/context.js';
import type { TranslationKey } from '../i18n/en.js';
import { IconShield, IconAlert, IconBlock } from './icons.js';
import { short } from './components.js';

const META: Record<RiskReport['level'], { key: TranslationKey; Icon: typeof IconShield }> = {
  safe: { key: 'risk.safe', Icon: IconShield },
  warning: { key: 'risk.warning', Icon: IconAlert },
  block: { key: 'risk.block', Icon: IconBlock },
};

export function RiskCard({ report }: { report: RiskReport }) {
  const { t } = useI18n();
  const { key, Icon } = META[report.level];

  return (
    <div
      className={`risk risk--${report.level}${report.level === 'block' ? ' marked' : ''}`}
      data-testid="risk-card"
      data-level={report.level}
    >
      <div className="risk__head">
        <Icon width={18} height={18} />
        {t(key)}
      </div>
      {report.reasons.length > 0 && (
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
            return <li key={r.code}>{text}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
