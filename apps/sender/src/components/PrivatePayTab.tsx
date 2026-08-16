import { useMemo, useState } from 'react';
import { parseUnits, isAddress, type Address, type Hex } from 'viem';
import {
  ADDRESSES,
  SPEND_POLICY_FACTORY_ADDRESS,
  settlePrivatePaymentBatched,
  RemoteCoSigner,
  MODE_PUSH,
  explorerTxUrl,
  percentOf,
  spendableAfterGas,
  usdc,
  PAY_GAS_LIMIT,
} from '@ctrl-arcz/sdk';
import { supportsChain, type Session } from '@ctrl-arcz/demo-kit';
import {
  AmountField,
  Button,
  Card,
  CopyButton,
  CostBlock,
  Field,
  Input,
  NeedsChain,
  Stepper,
  parseAmount,
  IconLock,
  IconExternal,
  useSubmitGuard,
  useT,
  useToast,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { useRecipientGate } from '../lib/useRecipientGate.js';
import { useGasReserve } from '../lib/useGasReserve.js';
import { RiskGate } from './RiskGate.js';

const USDC = ADDRESSES.USDC as Address;
const EXPIRY_SECONDS = 900; // 15 minutes, like a disposable card

type Phase = 'idle' | 'creating' | 'funding' | 'machine' | 'paying' | 'done' | 'vetoed';

interface Success {
  ephemeral: Address;
  amount: string;
  merchant: Address;
  txHash: Hex;
}
interface Veto {
  reason: string;
  riskReasons?: string[];
}

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as Hex;
}

export function PrivatePayTab({
  session,
  balance,
  onSwitchChain,
}: {
  session: Session;
  balance: bigint | null;
  onSwitchChain: (chainId: number) => Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const guard = useSubmitGuard();
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('0.02');
  const [phase, setPhase] = useState<Phase>('idle');
  const [success, setSuccess] = useState<Success | null>(null);
  const [veto, setVeto] = useState<Veto | null>(null);

  const amountValue = Number(amount);
  const validMerchant = isAddress(merchant);

  /**
   * A private payment sends three transactions from this wallet -- deploy the
   * disposable account, fund it, pay the merchant out of it -- and on Arc all three
   * are paid for in the money being sent. A bigger limit than the plain send for
   * that reason: running out after the account exists and holds the money, but
   * before the transaction that pays it out, is the one failure with nowhere to go.
   */
  const reserve = useGasReserve(PAY_GAS_LIMIT);
  const spendable =
    balance == null || reserve == null ? null : spendableAfterGas(balance, reserve);
  // The same parser the field uses, so the block can never total a figure the form
  // would not accept.
  const amountAmt = parseAmount(amount) ?? 0n;

  /**
   * The same firewall the send screen runs, on the same address, before anything
   * is signed.
   *
   * The co-signer already checks this merchant server-side and vetoes a bad one,
   * so no payment could ever reach a lookalike. What was missing was everything
   * before that: the user typed an address, got no signal at all, filled in an
   * amount, pressed pay, and only then learned the address was a twin of someone
   * they had paid. A verdict that arrives after the decision is not a firewall,
   * it is a receipt. Now it arrives while they are still typing, and the button
   * never arms for an address the co-signer is going to refuse anyway.
   */
  const gate = useRecipientGate(session, merchant);

  /**
   * The contracts and the co-signer both live on one chain, and `session.clients`
   * is pinned to it. Without this the form armed on any network and the payment
   * ran against Arc anyway, which is a transaction the user did not ask for from
   * the account they were looking at.
   */
  const onSupportedChain = supportsChain(session.chainId, 'privatePay');

  const canPay =
    onSupportedChain &&
    validMerchant &&
    amountValue > 0 &&
    gate.armed &&
    (phase === 'idle' || phase === 'done' || phase === 'vetoed');

  const steps: Step[] = useMemo(() => {
    const order: Phase[] = ['machine', 'paying'];
    const labels = [t('ppay.step.machine'), t('ppay.step.pay')];
    const active = order.indexOf(phase);
    return labels.map((label, i) => ({
      label,
      status:
        phase === 'done'
          ? 'done'
          : active < 0
            ? 'pending'
            : i < active
              ? 'done'
              : i === active
                ? 'active'
                : 'pending',
    }));
  }, [phase, t]);

  async function run() {
    setSuccess(null);
    setVeto(null);
    const clients = session.clients;
    const owner = session.address as Address;
    const to = merchant as Address;
    const amt = parseUnits(amount, 6);

    const showVeto = (reason: string, riskReasons?: string[]) => {
      setPhase('vetoed');
      setVeto({ reason, ...(riskReasons ? { riskReasons } : {}) });
      toast.push(t('ppay.vetoedToast'), 'error');
    };

    try {
      const cosignerAddress = (await fetch('/api/cosign').then((r) => r.json())).address as Address;
      const cosigner = new RemoteCoSigner('/api/cosign', cosignerAddress, undefined, {
        address: owner,
        sign: (message) =>
          clients.walletClient.signMessage({ account: clients.walletClient.account!, message }),
      });
      const salt = randomSalt();
      const expiry = Math.floor(Date.now() / 1000) + EXPIRY_SECONDS;

      // Create + fund + pay in ONE transaction. The Machine signs for the box's
      // counterfactual address (it does not exist yet); the CREATE2 salt commits the
      // policy to that address, so signing nonce 0 for it is safe.
      //
      // There is no separate precheck call: it ran the same firewall behind a second
      // wallet signature, and nothing exists on chain until the transaction below, so
      // a veto here stops the payment just as early. One signature, one transaction.
      setPhase('machine');
      const outcome = await settlePrivatePaymentBatched(
        clients,
        SPEND_POLICY_FACTORY_ADDRESS,
        salt,
        {
          token: USDC,
          owner,
          cosigner: cosignerAddress,
          vault: owner, // sweeps return to the payer's own wallet
          target: to,
          maxAmount: amt,
          expiry,
          interval: 0,
          mode: MODE_PUSH,
        },
        cosigner,
        { owner, onPhase: (p) => setPhase(p === 'submitting' ? 'paying' : 'machine') },
      );
      if (!outcome.ok) return showVeto(outcome.reason, outcome.riskReasons);

      setSuccess({ ephemeral: outcome.result.account, amount, merchant: to, txHash: outcome.result.txHash });
      setPhase('done');
      toast.push(t('ppay.doneToast'), 'success');
    } catch (e) {
      setPhase('idle');
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  return (
    <>
      {/* Same treatment as the other cards: the summary and the three points are
          one `i` beside the title rather than a paragraph and a dot in a row of
          their own. */}
      <Card
        title={t('ppay.title')}
        infoLabel={t('ppay.info.aria')}
        info={
          <>
            <p>{t('ppay.summary')}</p>
            <div className="infopop__item">
              <span className="infopop__k">{t('ppay.info.k1')}</span>
              <p>{t('ppay.point1')}</p>
            </div>
            <div className="infopop__item">
              <span className="infopop__k">{t('ppay.info.k2')}</span>
              <p>{t('ppay.point2')}</p>
            </div>
            <div className="infopop__item">
              <span className="infopop__k">{t('ppay.info.k3')}</span>
              <p>{t('ppay.point3')}</p>
            </div>
          </>
        }
        data-testid="privatepay-tab"
      >
        <div className="formstack">
          {!onSupportedChain ? (
            <NeedsChain feature="privatePay" onSwitch={onSwitchChain} />
          ) : (
            <>
          <Field
            label={t('ppay.merchant')}
            error={merchant.length > 0 && !validMerchant ? t('send.invalidAddress') : null}
          >
            <Input
              mono
              value={merchant}
              onChange={(e) => setMerchant(e.target.value.trim())}
              onClear={() => setMerchant('')}
              placeholder="0x…"
              data-testid="ppay-merchant"
              spellCheck={false}
              autoComplete="off"
              invalid={merchant.length > 0 && !validMerchant}
            />
          </Field>

          <RiskGate gate={gate} overridable={false} recoverable={false} data-testid="ppay-risk" />

          <AmountField
            value={amount}
            onChange={setAmount}
            chain="Arc_Testnet"
            balance={balance}
            onMax={(f) => spendable != null && setAmount(percentOf(spendable, f))}
            boxed
            data-testid="ppay-amount"
          />

          {/* This screen said nothing at all about cost until the money had moved,
              and it is the one that spends the most on gas. */}
          {reserve != null && (
            <CostBlock
              testId="ppay-cost"
              lines={[
                { label: t('cost.amount'), value: `${usdc(amountAmt)} USDC` },
                { label: t('cost.networkMax'), value: `${usdc(reserve)} USDC` },
              ]}
              total={{
                label: t('cost.youPay'),
                value: `${usdc(amountAmt + reserve)} USDC`,
                testId: 'ppay-youpay',
              }}
            />
          )}

          <Button
            onClick={() => void guard(run)}
            disabled={!canPay}
            loading={phase !== 'idle' && phase !== 'done' && phase !== 'vetoed'}
            data-testid="ppay-submit"
          >
            {t('ppay.button')}
          </Button>

          {phase !== 'idle' && <Stepper steps={steps} />}
            </>
          )}
        </div>
      </Card>

      {veto && (
        <Card data-testid="ppay-veto">
          <div className="row" style={{ color: 'var(--block)', marginBottom: 8 }}>
            <IconLock width={20} height={20} />
            <h2 className="card__title" style={{ margin: 0 }}>
              {t('ppay.vetoTitle')}
            </h2>
          </div>
          <p className="muted">{t('ppay.vetoBody')}</p>
          <div className="veto">
            <div className="veto__reason">{veto.reason}</div>
            {veto.riskReasons?.map((r, i) => (
              <p key={i} className="veto__risk">
                {r}
              </p>
            ))}
          </div>
        </Card>
      )}

      {success && (
        <Card data-testid="ppay-success">
          <div className="row" style={{ color: 'var(--safe)', marginBottom: 8 }}>
            <IconLock width={20} height={20} />
            <h2 className="card__title" style={{ margin: 0 }}>
              {t('ppay.successTitle')}
            </h2>
          </div>
          <p className="muted">{t('ppay.successBody', { amount: success.amount })}</p>

          <div style={{ marginTop: 16 }}>
            <div className="field__label">{t('ppay.merchantSees')}</div>
            <div className="row" style={{ marginTop: 6 }}>
              <Input
                className="grow"
                mono
                readOnly
                value={success.ephemeral}
                onFocus={(e) => e.currentTarget.select()}
                data-testid="ppay-ephemeral"
              />
              <CopyButton value={success.ephemeral} />
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              {t('ppay.successNote')}
            </p>
          </div>

          <div className="row-between" style={{ marginTop: 16 }}>
            <a
              className="row"
              href={explorerTxUrl(success.txHash)}
              target="_blank"
              rel="noreferrer"
            >
              {t('common.viewOnArcScan')} <IconExternal width={14} height={14} />
            </a>
            <Button
              variant="ghost"
              onClick={() => {
                setSuccess(null);
                setPhase('idle');
              }}
              data-testid="ppay-new"
            >
              {t('ppay.newPayment')}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
