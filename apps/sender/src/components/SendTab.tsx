import { useState } from 'react';
import { isAddress, parseUnits, type Address } from 'viem';
import {
  approvePermit2,
  approveUsdc,
  defineConfig,
  explorerTxUrl,
  generateClaimCode,
  recommendTransferMode,
  registerConfig,
  RiskBlockedError,
  sendProtected,
  sendProtectedWithPermit,
} from '@ctrl-arcz/sdk';
import type { Session } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  Checkbox,
  CopyButton,
  Field,
  Input,
  Select,
  Stepper,
  useSubmitGuard,
  useT,
  useToast,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { IconButton, IconChevron, IconExternal, IconLock, short } from '@ctrl-arcz/demo-kit/ui';
import { saveTransfer } from '../store.js';
import { config } from '../lib/riskConfig.js';
import { useRecipientGate } from '../lib/useRecipientGate.js';
import { RiskGate } from './RiskGate.js';
import { craftLookalikeOfKnownRecipient } from '../lib/poisoning.js';
import { clearVerifiedRecipients } from '../lib/verifiedRecipients.js';

/**
 * The SDK's 10 USDC default for `minProtectedAmount` is priced for a chain where
 * two extra transactions cost real money. On Arc they cost 0.0017 USDC, measured,
 * because gas is USDC and blocks are cheap. Leaving the default in place made the
 * app tell every user that an unprotected transfer "may be cheaper" on every send
 * a testnet faucet can fund — advice that is false here, and advice against the
 * one thing this app exists to do.
 *
 * 0.05 USDC is roughly thirty times the measured protection cost, so below it the
 * hint is true and above it the app stays quiet.
 */
interface SentInfo {
  transferId: string;
  /** The one string the recipient needs. Nothing else is handed over. */
  secret: string;
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
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The poisoning scenario: which real address the lookalike in the field imitates.
  const [crafting, setCrafting] = useState(false);
  const [poisonOf, setPoisonOf] = useState<string | null>(null);
  const [sent, setSent] = useState<SentInfo | null>(null);

  const isSelf = isAddress(to) && to.toLowerCase() === session.address.toLowerCase();
  const addrValid = to === '' || (isAddress(to) && !isSelf);
  const addrError =
    to !== '' && !isAddress(to) ? t('send.invalidAddress') : isSelf ? t('send.selfSend') : null;

  /**
   * The firewall, as one gate. This screen used to own the whole thing, and every
   * other way of sending copied a different half of it.
   */
  const gate = useRecipientGate(session, to);
  const { investigating, activeReport } = gate;

  const amountValue = (() => {
    try {
      return amount ? parseUnits(amount, 6) : 0n;
    } catch {
      return -1n;
    }
  })();
  const mode = amountValue > 0n ? recommendTransferMode(config, amountValue) : null;

  // `gate.armed` carries the firewall's whole opinion, including the wait for a
  // verdict that is still forming. What is left here is this screen's own: a
  // valid recipient who is not you, an amount, and not already sending.
  const canSend =
    session.onArc && isAddress(to) && !isSelf && amountValue > 0n && !busy && gate.armed;

  const steps: Step[] = [t('send.stepConfig'), t('send.stepApprove'), t('send.stepLock')].map(
    (label, i) => ({ label, status: step > i ? 'done' : step === i ? 'active' : 'pending' }),
  );

  const windowOptions = [
    { value: '60', label: t('send.window60s') },
    { value: '3600', label: t('send.window1h') },
    { value: '86400', label: t('send.window24h') },
  ];

  async function craftPoisoned() {
    setCrafting(true);
    try {
      const crafted = await craftLookalikeOfKnownRecipient(session.address as Address);
      if (!crafted) {
        toast.push(t('demo.noHistory'), 'error');
        return;
      }
      setPoisonOf(crafted.real);
      setTo(crafted.fake); // the existing debounced check runs and renders the verdict
    } finally {
      setCrafting(false);
    }
  }

  async function handleSend() {
    setError(null);
    if (!isAddress(to) || isSelf) return setError(t('send.invalidAddress'));
    if (amountValue <= 0n) return setError(t('send.invalidAmount'));
    // `gate.refused` is the block the user has not overridden. A block they have
    // looked at and accepted is not a reason to stop here; the SDK still decides.
    if (gate.refused || investigating || !session.onArc) return;

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
      // The acknowledgement travels with the send or it does nothing: the SDK runs
      // its own guard and refuses again unless it is handed the verdict the user
      // actually looked at. That is the point of passing the report rather than a
      // flag, and it is why the button cannot grant permission on its own.
      const guard = {
        config: sendConfig,
        ...(activeReport ? { report: activeReport } : {}),
        ...(gate.acknowledged ? { acknowledged: gate.acknowledged } : {}),
      };

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
        secret: secret.secret,
        txHash: result.txHash,
        createdAt: Date.now(),
      });

      setSent({
        transferId: result.transferId.toString(),
        secret: secret.secret,
        txHash: result.txHash,
        amount,
      });
      clearVerifiedRecipients();
      toast.push(t('send.sentToast'), 'success');
      setTo('');
      setAmount('');
      gate.setThrownReport(null);
      onSent();
    } catch (e) {
      if (e instanceof RiskBlockedError) {
        // The SDK's own firewall stopped the send. It carries the full report, so
        // show the same card the pre-send scan would have, not a raw message.
        gate.setThrownReport(e.report);
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
    return (
      <Card data-testid="send-success">
        <div className="row" style={{ color: 'var(--safe)', marginBottom: 8 }}>
          <IconLock width={20} height={20} />
          <h2 className="card__title" style={{ margin: 0 }}>
            {t('send.successTitle')}
          </h2>
        </div>
        <p className="muted">{t('send.successBody', { amount: sent.amount })}</p>
        {/* The whole credential, and the only thing that leaves this screen. It is
            not persisted and not put in a link: it has to reach the recipient
            through a channel an attacker is not in. */}
        <div className="code-reveal marked" data-testid="claim-code">
          {sent.secret}
        </div>
        <div className="row" style={{ marginTop: 10, justifyContent: 'center' }}>
          <CopyButton value={sent.secret} />
        </div>
        <ul className="hintlist">
          <li>{t('send.claimStep1')}</li>
          <li>{t('send.claimStep2')}</li>
        </ul>

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

      {/* The attack, in one click, in the place it actually happens. It crafts a
          real lookalike of someone this wallet has already paid and drops it into
          the field above, so the firewall you are about to trust is the one that
          judges it. Nothing is sent; the verdict appears where every verdict does. */}
      <div className="row-between wrap" style={{ marginTop: 8 }}>
        <Button
          variant="ghost"
          size="sm"
          loading={crafting}
          disabled={crafting}
          data-testid="poison-demo"
          onClick={() => void craftPoisoned()}
        >
          {t('demo.tryIt')}
        </Button>
        {gate.hasVerdict && (
          <IconButton
            label={t(gate.allOpen ? 'risk.collapseAll' : 'risk.expandAll')}
            className={`verdict-fold${gate.allOpen ? ' is-open' : ''}`}
            data-testid="verdicts-toggle-all"
            onClick={gate.toggleAll}
          >
            <IconChevron width={16} height={16} />
          </IconButton>
        )}
      </div>
      {poisonOf && (
        <p className="muted" style={{ marginTop: 6 }} data-testid="poison-note">
          {t('demo.craftedFrom').replace('{addr}', short(poisonOf))}
        </p>
      )}

      <RiskGate gate={gate} />

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
            : gate.refused
              ? t('send.blocked')
              : !session.onArc
                ? t('send.switchFirst')
                : investigating
                  ? t('send.waitingAdvisory')
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
