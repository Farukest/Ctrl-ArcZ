import { useCallback, useEffect, useRef, useState } from 'react';
import { isAddress, parseUnits, type Address } from 'viem';
import {
  approvePermit2,
  approveUsdc,
  check,
  defineConfig,
  explorerTxUrl,
  generateClaimCode,
  recommendTransferMode,
  registerConfig,
  RiskBlockedError,
  sendProtected,
  sendProtectedWithPermit,
  shouldBlockSend,
  type RiskReport,
} from '@ctrl-arcz/sdk';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  Checkbox,
  CopyButton,
  Field,
  Input,
  RiskCard,
  Select,
  Skeleton,
  Stepper,
  useSubmitGuard,
  useT,
  useToast,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { IconExternal, IconLock } from '@ctrl-arcz/demo-kit/ui';
import { saveTransfer } from '../store.js';

const config = defineConfig({ recallWindow: 3600, onWarning: 'warn' });
const RECEIVER_URL = import.meta.env.VITE_RECEIVER_URL ?? 'http://localhost:5174';

interface SentInfo {
  transferId: string;
  code: string;
  salt: `0x${string}`;
  txHash: `0x${string}`;
  amount: string;
}

export function SendTab({ session, onSent }: { session: Session; onSent: () => void }) {
  const toast = useToast();
  const t = useT();
  const guard = useSubmitGuard();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [windowSec, setWindowSec] = useState('3600');
  const [usePermit, setUsePermit] = useState(false);
  const [report, setReport] = useState<RiskReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentInfo | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  // Bumped on every check dispatch so a slow, stale response can never overwrite
  // the verdict for the address currently in the box (a poisoning-firewall race).
  const reqId = useRef(0);

  const isSelf = isAddress(to) && to.toLowerCase() === session.address.toLowerCase();
  const addrValid = to === '' || (isAddress(to) && !isSelf);
  const addrError =
    to !== '' && !isAddress(to) ? t('send.invalidAddress') : isSelf ? t('send.selfSend') : null;

  const runCheck = useCallback(
    (target: string) => {
      const id = ++reqId.current;
      if (!isAddress(target)) {
        setReport(null);
        setChecking(false);
        return;
      }
      setChecking(true);
      check(session.address as Address, target as Address, { client: getPublicClient() })
        .then((r) => {
          if (id === reqId.current) setReport(r);
        })
        .catch(() => {
          if (id === reqId.current) setReport(null);
        })
        .finally(() => {
          if (id === reqId.current) setChecking(false);
        });
    },
    [session.address],
  );

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => runCheck(to), 400);
    return () => clearTimeout(debounce.current);
  }, [to, runCheck]);

  // Only trust the report when it belongs to the address currently in the box, so
  // a verdict for a previously-typed address is never shown for a new one.
  const activeReport =
    report && isAddress(to) && report.target.toLowerCase() === to.toLowerCase() ? report : null;
  const blocked = activeReport ? shouldBlockSend(config, activeReport.level) : false;
  const amountValue = (() => {
    try {
      return amount ? parseUnits(amount, 6) : 0n;
    } catch {
      return -1n;
    }
  })();
  const mode = amountValue > 0n ? recommendTransferMode(config, amountValue) : null;

  const canSend =
    session.onArc && isAddress(to) && !isSelf && amountValue > 0n && !blocked && !busy && !checking;

  const steps: Step[] = [t('send.stepConfig'), t('send.stepApprove'), t('send.stepLock')].map(
    (label, i) => ({ label, status: step > i ? 'done' : step === i ? 'active' : 'pending' }),
  );

  const windowOptions = [
    { value: '60', label: t('send.window60s') },
    { value: '3600', label: t('send.window1h') },
    { value: '86400', label: t('send.window24h') },
  ];

  async function handleSend() {
    setError(null);
    if (!isAddress(to) || isSelf) return setError(t('send.invalidAddress'));
    if (amountValue <= 0n) return setError(t('send.invalidAmount'));
    if (blocked || !session.onArc) return;

    setBusy(true);
    setStep(0);
    try {
      const sendConfig = defineConfig({
        recallWindow: Number(windowSec),
        onWarning: config.onWarning,
      });
      const { configId } = await registerConfig(session.clients, sendConfig);
      setStep(1);

      const secret = generateClaimCode();
      const args = {
        configId,
        to: to as Address,
        amount: amountValue,
        claimHash: secret.claimHash,
      };

      // The SDK's own pre-send firewall stays on: this is the code path an
      // integrator gets by default, so the demo exercises it rather than opting
      // out. The report the UI already fetched is handed over, so the guard runs
      // on the same verdict instead of scanning the address a second time. It
      // re-scans by itself if that report is stale or about another address.
      const guard = { config: sendConfig, ...(activeReport ? { report: activeReport } : {}) };

      let result;
      if (usePermit) {
        await approvePermit2(session.clients);
        setStep(2);
        result = await sendProtectedWithPermit(session.clients, args, guard);
      } else {
        await approveUsdc(session.clients, amountValue);
        setStep(2);
        result = await sendProtected(session.clients, args, guard);
      }

      saveTransfer(session.address as Address, {
        transferId: result.transferId.toString(),
        to: to as Address,
        amount,
        code: secret.code,
        salt: secret.salt,
        txHash: result.txHash,
        createdAt: Date.now(),
      });

      setSent({
        transferId: result.transferId.toString(),
        code: secret.code,
        salt: secret.salt,
        txHash: result.txHash,
        amount,
      });
      toast.push(t('send.sentToast'), 'success');
      setTo('');
      setAmount('');
      setReport(null);
      onSent();
    } catch (e) {
      if (e instanceof RiskBlockedError) {
        // The SDK's own firewall stopped the send. It carries the full report, so
        // show the same card the pre-send scan would have, not a raw message.
        setReport(e.report);
        setError(null);
        toast.push(t('send.blockedToast'), 'error');
      } else {
        setError(e instanceof Error ? e.message : String(e));
        toast.push(t('send.failedToast'), 'error');
      }
    } finally {
      setBusy(false);
      setStep(0);
    }
  }

  if (sent) {
    const claimLink = `${RECEIVER_URL}/?tid=${sent.transferId}&salt=${sent.salt}`;
    return (
      <Card data-testid="send-success">
        <div className="row" style={{ color: 'var(--safe)', marginBottom: 8 }}>
          <IconLock width={20} height={20} />
          <h2 className="card__title" style={{ margin: 0 }}>
            {t('send.successTitle')}
          </h2>
        </div>
        <p className="muted">{t('send.successBody', { amount: sent.amount })}</p>
        <div className="code-reveal marked" data-testid="claim-code">
          {sent.code}
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="field__label">{t('send.claimLinkLabel')}</div>
          <div className="row" style={{ marginTop: 6 }}>
            <Input
              className="grow"
              readOnly
              value={claimLink}
              data-testid="claim-link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton value={claimLink} />
          </div>
          <ul className="hintlist">
            <li>{t('send.claimStep1')}</li>
            <li>{t('send.claimStep2')}</li>
          </ul>
        </div>

        <div className="row-between" style={{ marginTop: 16 }}>
          <a className="row" href={explorerTxUrl(sent.txHash)} target="_blank" rel="noreferrer">
            {t('common.viewOnArcScan')} <IconExternal width={14} height={14} />
          </a>
          <Button variant="ghost" onClick={() => setSent(null)}>
            {t('send.newTransfer')}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <Field label={t('send.recipient')} error={addrError}>
        <Input
          mono
          invalid={!addrValid}
          placeholder="0x…"
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          data-testid="recipient-input"
          spellCheck={false}
          autoComplete="off"
        />
      </Field>

      {checking && (
        <div style={{ marginTop: 12 }}>
          <Skeleton height={56} />
        </div>
      )}
      {!checking && activeReport && (
        <div style={{ marginTop: 12 }}>
          <RiskCard report={activeReport} />
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Field label={t('send.amount')} hint={mode === 'plain' ? t('send.plainHint') : undefined}>
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            data-testid="amount-input"
          />
        </Field>
      </div>

      <div style={{ marginTop: 16 }}>
        <Field label={t('send.window')}>
          <Select
            value={windowSec}
            options={windowOptions}
            onChange={setWindowSec}
            ariaLabel={t('send.window')}
            full
          />
        </Field>
      </div>

      <div style={{ marginTop: 14 }}>
        <Checkbox
          checked={usePermit}
          onChange={(e) => setUsePermit(e.target.checked)}
          data-testid="permit-toggle"
          label={t('send.permitToggle')}
        />
      </div>

      {busy && <Stepper steps={steps} />}

      <div style={{ marginTop: 16 }}>
        <Button
          full
          onClick={() => void guard(handleSend)}
          disabled={!canSend}
          loading={busy}
          data-testid="send-button"
        >
          {busy
            ? t('send.sending')
            : blocked
              ? t('send.blocked')
              : !session.onArc
                ? t('send.switchFirst')
                : t('send.button')}
        </Button>
      </div>
      {error && (
        <div className="err-text" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </Card>
  );
}
