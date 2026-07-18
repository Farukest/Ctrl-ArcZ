import { useMemo, useState } from 'react';
import { parseUnits, isAddress, erc20Abi, type Address, type Hex } from 'viem';
import {
  ADDRESSES,
  SPEND_POLICY_FACTORY_ADDRESS,
  SHIELD_VAULT_ADDRESS,
  predictEphemeral,
  createEphemeral,
  submitPay,
  payStructHash,
  RemoteCoSigner,
  MODE_PUSH,
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

    try {
      const cosignerAddress = (await fetch('/api/cosign').then((r) => r.json())).address as Address;
      const salt = randomSalt();
      const expiry = Math.floor(Date.now() / 1000) + EXPIRY_SECONDS;
      const chainId = BigInt(await clients.publicClient.getChainId());

      // 1. The Machine checks FIRST, on the fresh (predicted) address. A veto here
      //    means nothing is created and no funds ever move — the payment is stopped
      //    before it can send, not clawed back after.
      setPhase('machine');
      const account = await predictEphemeral(
        clients.publicClient,
        SPEND_POLICY_FACTORY_ADDRESS,
        owner,
        salt,
      );
      const cosigner = new RemoteCoSigner('/api/cosign', cosignerAddress);
      const auth = await cosigner.authorize({
        account,
        owner,
        target: to,
        amount: amt,
        nonce: 0n,
        chainId,
        policy: { lockedTarget: to, remaining: amt, expiry },
      });
      if (!auth.approved) {
        setPhase('vetoed');
        setVeto({
          reason: auth.reason,
          ...(auth.riskReasons ? { riskReasons: auth.riskReasons } : {}),
        });
        toast.push(t('ppay.vetoedToast'), 'error');
        return;
      }

      // 2. Create the disposable address, locked to this merchant.
      setPhase('creating');
      await createEphemeral(clients, SPEND_POLICY_FACTORY_ADDRESS, salt, {
        token: USDC,
        owner,
        cosigner: cosignerAddress,
        vault: SHIELD_VAULT_ADDRESS,
        target: to,
        maxAmount: amt,
        expiry,
        interval: 0,
        mode: MODE_PUSH,
      });

      // 3. Fund it. In production this leg is confidential (Arc Privacy Sector);
      //    in the demo the owner funds it directly.
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

      // 4. Pay: the owner signs (nonce 0) and submits with The Machine's signature.
      setPhase('paying');
      const digest = payStructHash({ account, target: to, amount: amt, nonce: 0n, chainId });
      const ownerSig = await clients.walletClient.signMessage({
        account: clients.walletClient.account!,
        message: { raw: digest },
      });
      const txHash = await submitPay(clients, account, amt, ownerSig, auth.signature);

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
