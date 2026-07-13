import { useState } from 'react';
import type { Address } from 'viem';
import { check, craftLookalike, type RiskReport } from '@ctrl-arcz/sdk';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import { Button, Card, RiskCard, useSubmitGuard, useT, short } from '@ctrl-arcz/demo-kit/ui';

/**
 * The address the scenario crafts a lookalike of. Read from the environment
 * only: no wallet address is baked into the source, so the demo carries nobody's
 * address into a clone or a bundle. Set it in `apps/sender/.env.local`.
 */
const TRUSTED = import.meta.env.VITE_DEMO_RECEIVER as Address | undefined;

export function DemoTab({ session }: { session: Session }) {
  const t = useT();
  const guard = useSubmitGuard();
  const [lookalike, setLookalike] = useState<Address | null>(null);
  const [report, setReport] = useState<RiskReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!TRUSTED) {
    return (
      <Card data-testid="demo-tab" title={t('demo.title')}>
        <p className="muted">{t('demo.notConfigured')}</p>
      </Card>
    );
  }

  async function run() {
    if (!TRUSTED) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const fake = craftLookalike(TRUSTED);
      setLookalike(fake);
      setReport(await check(session.address as Address, fake, { client: getPublicClient() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="demo-tab" title={t('demo.title')}>
      <p className="muted">{t('demo.body', { addr: short(TRUSTED) })}</p>

      <Button
        onClick={() => void guard(run)}
        loading={busy}
        data-testid="run-demo"
        style={{ marginTop: 4 }}
      >
        {busy ? t('demo.running') : t('demo.run')}
      </Button>

      {lookalike && (
        <div style={{ marginTop: 16 }} className="stack">
          <div>
            <div className="hint">{t('demo.realAddress')}</div>
            <div className="mono mono--wrap">{TRUSTED}</div>
          </div>
          <div>
            <div className="hint">{t('demo.fakeAddress')}</div>
            <div className="mono mono--wrap" data-testid="lookalike-address">
              {lookalike}
            </div>
          </div>
          <p className="hint">{t('demo.indistinguishable', { addr: short(TRUSTED) })}</p>
        </div>
      )}

      {report && (
        <div style={{ marginTop: 12 }}>
          <RiskCard report={report} />
        </div>
      )}
      {error && (
        <div className="err-text" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </Card>
  );
}
