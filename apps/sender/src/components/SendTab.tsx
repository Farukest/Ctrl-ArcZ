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
import { IconExternal, IconLock, short } from '@ctrl-arcz/demo-kit/ui';
import { saveTransfer } from '../store.js';
import { craftLookalikeOfKnownRecipient } from '../lib/poisoning.js';
import { investigate, effectiveLevel, type Advisory } from '../lib/investigate.js';
import { apiToken, clearApiToken } from '../lib/apiToken.js';
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
const config = defineConfig({
  recallWindow: 3600,
  onWarning: 'warn',
  minProtectedAmount: 50_000n,
});
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
  const [report, setReport] = useState<RiskReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The poisoning scenario: which real address the lookalike in the field imitates.
  const [crafting, setCrafting] = useState(false);
  const [poisonOf, setPoisonOf] = useState<string | null>(null);
  // The server's reasoned second opinion. Null whenever it is off or unreachable.
  const [advisory, setAdvisory] = useState<Advisory | null>(null);
  const [investigating, setInvestigating] = useState(false);
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
      // Bound the RecipientVerified scan. Unbounded it walks from the deploy block in
      // 10k chunks, which is hundreds of eth_getLogs per keystroke-debounced check and
      // gets the RPC to rate limit us (429) until the whole scan throws. The server
      // co-signer already uses the same bound as its cold-start fallback.
      setAdvisory(null);
      setInvestigating(false);
      // The verified set comes from the server's index, which has no block
      // window. Passing it in means `check` does no log scanning at all.
      verifiedRecipients(session.address as Address)
        .then(({ recipients }) =>
          check(session.address as Address, target as Address, {
            client: getPublicClient(),
            provider: riskProvider(),
            verifiedRecipients: recipients,
          }),
        )
        .then((r) => {
          if (id !== reqId.current) return;
          setReport(r);
          // Advisory is strictly additive: it arrives later, never gates the
          // rule verdict, and can only make the outcome stricter.
          //
          // It is asked on `safe` too, and that case is the reason it exists.
          // The clamp is `max(rule, advisory)`, so `safe` is the only verdict
          // with anywhere to go — skipping it as "nothing to escalate" read the
          // clamp backwards. It also skipped exactly the failure this feature
          // was built for: a contract you have genuinely paid before rates
          // `safe / KNOWN_COUNTERPARTY`, while a plain USDC transfer to it is
          // gone. No rule can see that; the dossier can.
          setInvestigating(true);
          void investigate(session, target as Address)
            .then((a) => {
              if (id === reqId.current) setAdvisory(a);
            })
            .finally(() => {
              if (id === reqId.current) setInvestigating(false);
            });
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
    clearRiskCache();
    clearVerifiedRecipients();

    // Warm both caches the moment a wallet connects. The firewall's slow half is
    // walking this sender's history through the indexer — ten pages, several
    // seconds each — and doing it lazily means the very first address a user
    // types sits under a spinner for half a minute. Starting it here spends that
    // time while they are still reading the form.
    const sender = session.address as Address;
    void riskProvider().getOutgoingCounterparties(sender).catch(() => {});
    void verifiedRecipients(sender);

    // Take the investigator's one signature here, next to the wallet connect the
    // user just performed, rather than letting it surprise them mid-address. A
    // prompt that appears while someone is typing a recipient reads as if the
    // app is asking to sign the payment, which is the last thing it should be
    // ambiguous about.
    clearApiToken();
    void apiToken(session);
  }, [session]);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => runCheck(to), 400);
    return () => clearTimeout(debounce.current);
  }, [to, runCheck]);

  // Only trust the report when it belongs to the address currently in the box, so
  // a verdict for a previously-typed address is never shown for a new one.
  const activeReport =
    report && isAddress(to) && report.target.toLowerCase() === to.toLowerCase() ? report : null;
  // The advisory may only tighten. `effectiveLevel` is the max of the two, so a
  // block can never be talked down and a caution can never become a green light.
  const level = activeReport ? effectiveLevel(activeReport.level, advisory) : null;
  const blocked = level ? shouldBlockSend(config, level) : false;
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
      <div style={{ marginTop: 8 }}>
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
          <RiskCard report={activeReport} />
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
        <div className={`risk risk--${advisory.level === 'safe' ? 'safe' : advisory.level === 'block' ? 'block' : 'warn'}`}
          style={{ marginTop: 10 }}
          data-testid="advisory"
        >
          <strong>{advisory.headline}</strong>
          {advisory.points.length > 0 && (
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
