import { useState } from 'react';
import type { RiskReport } from '@ctrl-arcz/sdk';
import { Button, Checkbox, useT } from '@ctrl-arcz/demo-kit/ui';

/**
 * The way past a refusal, for the person who is right and the app is wrong.
 *
 * The firewall refuses by default and that stays. But it decides from eight
 * matching hex characters, or from a zero-value transfer anyone can send you, and
 * both of those happen to real payments between real people. A refusal with no
 * way past it means the app sometimes just cannot pay a colleague, and telling
 * that person "it is for your safety" does not make it true.
 *
 * The design problem is that the poisoning victim is *certain*. They believe the
 * address is right; that belief is the attack. So a one-click "send anyway" is
 * useless: the person who would click it is exactly the person it must stop. What
 * breaks the certainty is not another confirmation, it is being made to look.
 *
 * So the escape hatch is the comparison. We already know which address the
 * lookalike is imitating, so both are shown in full, one above the other, with the
 * matching ends dimmed and the differing middle left bright. A victim sees it. A
 * false positive glances and moves on. Only after that is there a button, and it
 * needs a checkbox first.
 *
 * When there is nothing to compare against -- a data source did not answer, so the
 * check could not run -- the wording says exactly that instead. "We could not
 * check" is a different sentence from "this is dangerous", and pretending
 * otherwise trains people to click through both.
 */
export function RiskOverride({
  report,
  /** False for paths with no recall: a bridge or a private payment cannot be
   *  cancelled once it lands, so the copy must not imply a safety net. */
  recoverable = true,
  onAcknowledge,
  onCancel,
}: {
  report: RiskReport;
  recoverable?: boolean;
  onAcknowledge: (report: RiskReport) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const lookalikeOf = report.reasons.find((r) => r.code === 'LOOKALIKE_ADDRESS')?.lookalikeOf;
  const unverified = !lookalikeOf && !report.complete;

  if (!open) {
    return (
      <button
        type="button"
        className="risk-override__open"
        data-testid="risk-override-open"
        onClick={() => setOpen(true)}
      >
        {t(unverified ? 'risk.override.openUnverified' : 'risk.override.open')}
      </button>
    );
  }

  return (
    <div className="risk-override" data-testid="risk-override">
      {lookalikeOf ? (
        <>
          <p className="risk-override__title">{t('risk.override.compareTitle')}</p>
          <AddressDiff label={t('risk.override.yours')} address={report.target} other={lookalikeOf} />
          <AddressDiff label={t('risk.override.known')} address={lookalikeOf} other={report.target} />
          <p className="risk-override__note">{t('risk.override.middle')}</p>
        </>
      ) : (
        <>
          <p className="risk-override__title">
            {t(unverified ? 'risk.override.unverifiedTitle' : 'risk.override.compareTitle')}
          </p>
          <p className="risk-override__note">
            {unverified ? t('risk.override.unverifiedBody') : report.reasons[0]?.message}
          </p>
        </>
      )}

      <div style={{ marginTop: 12 }}>
        <Checkbox
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          label={t('risk.override.confirmLabel')}
          data-testid="risk-override-confirm"
        />
      </div>

      <p className="risk-override__note" style={{ marginTop: 8 }}>
        {t(recoverable ? 'risk.override.armed' : 'risk.override.armedPlain')}
      </p>

      <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
        <Button
          size="sm"
          variant="danger"
          disabled={!confirmed}
          data-testid="risk-override-proceed"
          onClick={() => onAcknowledge(report)}
        >
          {t('risk.override.proceed')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="risk-override-cancel"
          onClick={() => {
            setOpen(false);
            setConfirmed(false);
            onCancel();
          }}
        >
          {t('risk.override.cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * One address, with the part that matches the other one dimmed.
 *
 * The abbreviation every wallet shows (`0x64Ea…Fe3F`) is precisely the four
 * characters at each end, which is precisely what the attacker matched. Dimming
 * exactly those and leaving the rest bright puts the difference where the eye
 * goes, instead of asking someone to diff two 42-character strings themselves.
 */
function AddressDiff({
  label,
  address,
  other,
}: {
  label: string;
  address: string;
  other: string;
}) {
  const head = commonPrefix(address, other);
  const tail = commonSuffix(address.slice(head), other.slice(commonPrefix(other, address)));
  const middle = address.slice(head, address.length - tail);

  return (
    <div className="risk-override__addr" data-testid="risk-override-addr">
      <span className="risk-override__addrk">{label}</span>
      <span className="mono risk-override__addrv">
        <span className="risk-override__same">{address.slice(0, head)}</span>
        <span className="risk-override__diff">{middle}</span>
        <span className="risk-override__same">{address.slice(address.length - tail)}</span>
      </span>
    </div>
  );
}

function commonPrefix(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let i = 0;
  while (i < x.length && i < y.length && x[x.length - 1 - i] === y[y.length - 1 - i]) i++;
  return i;
}
