import { useEffect, useState } from 'react';
import { isAddress, parseUnits, type Address } from 'viem';
import type { RiskReport } from '@ctrl-arcz/sdk';
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
  RiskCard,
  Select,
  Skeleton,
  Stepper,
  useSubmitGuard,
  useT,
  useToast,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { IconButton, IconChevron, IconExternal, IconLock, short } from '@ctrl-arcz/demo-kit/ui';
import { saveTransfer } from '../store.js';
import { config } from '../lib/riskConfig.js';
import { useRecipientRisk } from '../lib/useRecipientRisk.js';
import { craftLookalikeOfKnownRecipient } from '../lib/poisoning.js';
import { riskProvider, clearRiskCache } from '../lib/riskProvider.js';
import { verifiedRecipients, clearVerifiedRecipients } from '../lib/verifiedRecipients.js';

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
  // Both verdicts fold independently. They stack, they are wordy by design, and on
  // a phone the amount field can end up below the fold because of them.
  const [ruleOpen, setRuleOpen] = useState(true);
  const [advisoryOpen, setAdvisoryOpen] = useState(true);
  const [sent, setSent] = useState<SentInfo | null>(null);

  const isSelf = isAddress(to) && to.toLowerCase() === session.address.toLowerCase();
  const addrValid = to === '' || (isAddress(to) && !isSelf);
  const addrError =
    to !== '' && !isAddress(to) ? t('send.invalidAddress') : isSelf ? t('send.selfSend') : null;

  /**
   * The firewall, from the shared hook. This screen used to own the whole thing,
   * and the bridge grew a recipient field next to it; two copies of a risk check
   * is how a strict front door ends up beside a lenient side door.
   */
  const risk = useRecipientRisk(session, to);
  const { advisory, checking, investigating, blocked } = risk;
  /**
   * A verdict the SDK threw at us, rather than one the hook fetched. `sendProtected`
   * runs the firewall again server-side and refuses with the full report; showing it
   * in the same card is the whole point, so it needs somewhere to live that the
   * hook does not own.
   */
  const [thrownReport, setThrownReport] = useState<RiskReport | null>(null);
  const activeReport = thrownReport ?? risk.report;

  useEffect(() => {
    clearRiskCache();
    clearVerifiedRecipients();

    // Warm both caches the moment a wallet connects. The firewall's slow half is
    // walking this sender's history through the indexer — ten pages, several
    // seconds each — and doing it lazily means the very first address a user
    // types sits under a spinner for half a minute. Starting it here spends that
    // time while they are still reading the form.
    const sender = session.address as Address;
    void riskProvider()
      .getOutgoingCounterparties(sender)
      .catch(() => {});
    void verifiedRecipients(sender);
  }, [session.address]);

  const amountValue = (() => {
    try {
      return amount ? parseUnits(amount, 6) : 0n;
    } catch {
      return -1n;
    }
  })();
  const mode = amountValue > 0n ? recommendTransferMode(config, amountValue) : null;

  // `!investigating` is part of arming the button, not a nicety. The advisory is
  // only allowed to tighten, and a verdict that can only tighten protects nobody
  // if the send can be signed before it lands: the rules say safe, the button
  // arms, and the escalation arrives for a transfer that already left. Waiting
  // the extra second is the difference between "it can only tighten" and "it can
  // only tighten if you were slow enough". A failed or disabled investigator
  // resolves immediately, so the feature being off costs nothing here.
  const canSend =
    session.onArc &&
    isAddress(to) &&
    !isSelf &&
    amountValue > 0n &&
    !blocked &&
    !busy &&
    !checking &&
    !investigating;

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
    if (blocked || investigating || !session.onArc) return;

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
      setThrownReport(null);
      onSent();
    } catch (e) {
      if (e instanceof RiskBlockedError) {
        // The SDK's own firewall stopped the send. It carries the full report, so
        // show the same card the pre-send scan would have, not a raw message.
        setThrownReport(e.report);
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
        {activeReport && (
          <IconButton
            label={t(ruleOpen && advisoryOpen ? 'risk.collapseAll' : 'risk.expandAll')}
            className={`verdict-fold${ruleOpen && advisoryOpen ? ' is-open' : ''}`}
            data-testid="verdicts-toggle-all"
            onClick={() => {
              const open = !(ruleOpen && advisoryOpen);
              setRuleOpen(open);
              setAdvisoryOpen(open);
            }}
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

      {checking && (
        <div style={{ marginTop: 12 }}>
          <Skeleton height={56} />
        </div>
      )}
      {!checking && activeReport && (
        <div style={{ marginTop: 12 }}>
          <RiskCard
            report={activeReport}
            collapsed={!ruleOpen}
            onToggle={() => setRuleOpen((v) => !v)}
          />
        </div>
      )}
      {/* The investigator answers seconds after the rules do. Without a line
          saying so, its box simply materialised later and nothing had told the
          user that a second opinion was even being sought — the feature looked
          like a glitch, or like nothing at all. */}
      {!checking && activeReport && investigating && !advisory && (
        <div style={{ marginTop: 10 }} data-testid="advisory-pending">
          <p className="muted" style={{ marginBottom: 6 }}>
            {t('risk.investigating')}
          </p>
          <Skeleton height={48} />
        </div>
      )}
      {!checking && activeReport && advisory && (
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
                className={`risk__toggle${advisoryOpen ? ' is-open' : ''}`}
                onClick={() => setAdvisoryOpen((v) => !v)}
                aria-expanded={advisoryOpen}
                aria-label={t(advisoryOpen ? 'risk.hide' : 'risk.show')}
                title={t(advisoryOpen ? 'risk.hide' : 'risk.show')}
                data-testid="advisory-toggle"
              >
                <IconChevron width={15} height={15} />
              </button>
            )}
          </div>
          {advisoryOpen && advisory.points.length > 0 && (
            <ul>
              {advisory.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
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
