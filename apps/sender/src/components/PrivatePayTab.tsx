import { useMemo, useState } from 'react';
import { parseUnits, isAddress, erc20Abi, type Address, type Hex } from 'viem';
import {
  ADDRESSES,
  SPEND_POLICY_FACTORY_ADDRESS,
  createEphemeral,
  readAccount,
  submitPay,
  RemoteCoSigner,
  MODE_PUSH,
  ACTION_PAY,
  explorerTxUrl,
} from '@ctrl-arcz/sdk';
import { type Session } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  CopyButton,
  Field,
  InfoPopover,
  Input,
  Stepper,
  IconLock,
  IconExternal,
  useSubmitGuard,
  useT,
  useToast,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';

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

export function PrivatePayTab({ session }: { session: Session }) {
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
  const canPay =
    validMerchant &&
    amountValue > 0 &&
    (phase === 'idle' || phase === 'done' || phase === 'vetoed');

  const steps: Step[] = useMemo(() => {
    const order: Phase[] = ['machine', 'creating', 'funding', 'paying'];
    const labels = [
      t('ppay.step.machine'),
      t('ppay.step.create'),
      t('ppay.step.fund'),
      t('ppay.step.pay'),
    ];
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
      const chainId = await clients.publicClient.getChainId();

      // 1. The Machine checks FIRST — the firewall runs before anything exists. A
      //    veto here means nothing is created and no funds ever move: the payment
      //    is stopped before it can send, not clawed back after.
      setPhase('machine');
      const pre = await cosigner.precheck({ owner, target: to, amount: amt });
      if (!pre.approved) return showVeto(pre.reason, pre.riskReasons);

      // 2. Create the disposable address, locked to this merchant. It stores no
      //    payer identity — only a hash of the owner (as the salt) and of the vault.
      setPhase('creating');
      const { account } = await createEphemeral(clients, SPEND_POLICY_FACTORY_ADDRESS, salt, {
        token: USDC,
        owner,
        cosigner: cosignerAddress,
        vault: owner, // sweeps return to the payer's own wallet
        target: to,
        maxAmount: amt,
        expiry,
        interval: 0,
        mode: MODE_PUSH,
      });

      // 3. The Machine authorizes the spend: the server reads the account's REAL
      //    policy from chain and signs. Nothing the browser claims is trusted.
      const state = await readAccount(clients.publicClient, account);
      const auth = await cosigner.authorize({
        account,
        owner,
        amount: amt,
        action: ACTION_PAY,
        target: state.target,
        nonce: state.nonce,
        chainId,
        remaining: state.remaining,
        expiry: state.expiry,
      });
      if (!auth.approved) return showVeto(auth.reason, auth.riskReasons);

      // 4. Fund it (owner -> ephemeral). In production this leg is confidential
      //    (Arc Privacy Sector); in the demo the owner funds it directly.
      setPhase('funding');
      const fundHash = await clients.walletClient.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [account, amt],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain ?? null,
      });
      await clients.publicClient.waitForTransactionReceipt({ hash: fundHash });

      // 5. Pay with The Machine's signature alone. The payer signs nothing blind —
      //    their only signature this whole flow was a plain, readable USDC transfer.
      setPhase('paying');
      const txHash = await submitPay(clients, account, amt, auth.signature);

      setSuccess({ ephemeral: account, amount, merchant: to, txHash });
      setPhase('done');
      toast.push(t('ppay.doneToast'), 'success');
    } catch (e) {
      setPhase('idle');
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  return (
    <>
      <Card title={t('ppay.title')} data-testid="privatepay-tab">
        <div className="row-between" style={{ gap: 'var(--sp-3)' }}>
          <p className="muted" style={{ margin: 0 }}>
            {t('ppay.summary')}
          </p>
          <InfoPopover label={t('ppay.info.aria')}>
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
          </InfoPopover>
        </div>

        <hr className="rule" />

        <div className="formstack">
          <Field
            label={t('ppay.merchant')}
            error={merchant.length > 0 && !validMerchant ? t('send.invalidAddress') : null}
          >
            <Input
              mono
              value={merchant}
              onChange={(e) => setMerchant(e.target.value.trim())}
              placeholder="0x…"
              data-testid="ppay-merchant"
              spellCheck={false}
              autoComplete="off"
              invalid={merchant.length > 0 && !validMerchant}
            />
          </Field>

          <Field label={t('ppay.amount')}>
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="ppay-amount"
              inputMode="decimal"
            />
          </Field>

          <Button
            onClick={() => void guard(run)}
            disabled={!canPay}
            loading={phase !== 'idle' && phase !== 'done' && phase !== 'vetoed'}
            data-testid="ppay-submit"
          >
            {t('ppay.button')}
          </Button>

          {phase !== 'idle' && <Stepper steps={steps} />}
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
