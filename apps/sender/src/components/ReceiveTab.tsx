import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { formatUnits, type Hex } from 'viem';
import type { Session } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  Field,
  Input,
  Skeleton,
  useSubmitGuard,
  useT,
  useToast,
  short,
  IconExternal,
} from '@ctrl-arcz/demo-kit/ui';
import {
  claim,
  explorerTxUrl,
  hashClaim,
  normaliseSecret,
  saltFromSecret,
  TransferLockedError,
  TransferUnavailableError,
  WrongClaimCodeError,
  type TransferUnavailableReason,
} from '@ctrl-arcz/sdk';
import { Confetti } from './Confetti.js';
import type { PendingClaim } from '../lib/usePendingClaims.js';

// Gasless claims are signed server-side (/api/gasless-claim) so the relayer and
// Circle keys never reach the browser bundle. Non-secret flag only.
const gaslessEnabled = import.meta.env.VITE_GASLESS_ENABLED !== 'false';

async function gaslessClaimViaServer(transferId: bigint, code: string, salt: Hex): Promise<Hex> {
  const res = await fetch('/api/gasless-claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transferId: transferId.toString(), code, salt }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    txHash?: string;
    error?: { kind: string; attemptsRemaining?: number; reason?: string; message?: string } | string;
  };
  if (res.ok && data.ok && data.txHash) return data.txHash as Hex;
  const err = data.error;
  if (typeof err === 'string') throw new Error(err);
  const zero = `0x${'0'.repeat(64)}` as Hex;
  if (err?.kind === 'wrong_code')
    throw new WrongClaimCodeError(transferId, err.attemptsRemaining ?? 0, zero);
  if (err?.kind === 'locked') throw new TransferLockedError(transferId, zero);
  if (err?.kind === 'unavailable')
    throw new TransferUnavailableError((err.reason ?? 'not_pending') as TransferUnavailableReason);
  throw new Error(err?.message ?? 'gasless claim failed');
}

export function ReceiveTab({
  session,
  pending,
  reload,
  balance,
  onClaimed,
}: {
  session: Session;
  pending: PendingClaim[] | null;
  reload: () => Promise<void>;
  balance: string;
  onClaimed: () => Promise<void> | void;
}) {
  const t = useT();
  const toast = useToast();
  const guard = useSubmitGuard();

  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [claimedTx, setClaimedTx] = useState<Hex | null>(null);
  const [qr, setQr] = useState('');

  // One string carries the whole proof, so the recipient types it and nothing else.
  // Deliberately not delivered by any address-keyed channel (chain, backend, push):
  // in a poisoning attack the recorded recipient is the attacker, so such a channel
  // would hand them the secret. It has to reach a human.
  const parsed = normaliseSecret(secret);

  // The secret says which transfer it belongs to: its commitment is on-chain, so the
  // app recomputes the hash and finds the match among the transfers waiting for this
  // wallet. Nobody has to read a transfer number off a list and type it back in.
  const matched = useMemo(() => {
    if (!parsed || !pending) return null;
    const want = hashClaim(saltFromSecret(parsed), parsed).toLowerCase();
    return pending.find((p) => p.transfer.claimHash.toLowerCase() === want) ?? null;
  }, [parsed, pending]);
  const noMatch = Boolean(parsed) && pending !== null && matched === null;

  useEffect(() => {
    QRCode.toDataURL(session.address, { margin: 1, width: 176 })
      .then(setQr)
      .catch(() => setQr(''));
  }, [session.address]);

  async function handleClaim(gasless: boolean) {
    if (!parsed) return toast.push(t('claim.codeInvalid'), 'error');
    if (!matched) return toast.push(t('claim.noMatch'), 'error');
    const salt = saltFromSecret(parsed);
    const id = matched.transferId;
    setBusy(true);
    try {
      const tx = gasless
        ? await gaslessClaimViaServer(id, parsed, salt)
        : await claim(session.clients, id, parsed, salt);
      setClaimedTx(tx);
      await onClaimed();
      await reload();
    } catch (e) {
      if (e instanceof WrongClaimCodeError) {
        toast.push(
          e.attemptsRemaining > 0
            ? t('claim.wrongCode', { n: e.attemptsRemaining })
            : t('claim.wrongCodeLast'),
          'error',
        );
      } else if (e instanceof TransferLockedError) {
        toast.push(t('claim.locked'), 'error');
      } else if (e instanceof TransferUnavailableError) {
        toast.push(t(`transfer.unavailable.${e.reason}` as never), 'error');
      } else {
        toast.push(e instanceof Error ? e.message : String(e), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(session.address);
      toast.push(t('common.copied'), 'success');
    } catch {
      /* ignore */
    }
  };

  if (claimedTx) {
    return (
      <>
        <Confetti />
        <Card data-testid="claim-success">
          <h2 className="card__title" style={{ color: 'var(--safe)' }}>
            {t('claim.successTitle')}
          </h2>
          <p className="muted">
            {t('claim.successBody', {
              balance: Number(balance).toLocaleString(undefined, { maximumFractionDigits: 4 }),
            })}
          </p>
          <a className="row" href={explorerTxUrl(claimedTx)} target="_blank" rel="noreferrer">
            {t('common.viewOnArcScan')} <IconExternal width={14} height={14} />
          </a>
          <div style={{ marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setClaimedTx(null)}>
              {t('common.back')}
            </Button>
          </div>
        </Card>
      </>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      {/* Get paid: your address + QR */}
      <Card title={t('receive.yourAddress')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('receive.shareToGetPaid')}
        </p>
        <div className="row wrap" style={{ alignItems: 'center', gap: 16 }}>
          {qr && (
            <img
              src={qr}
              alt=""
              width={148}
              height={148}
              style={{ borderRadius: 12, background: '#fff', padding: 8 }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mono" style={{ wordBreak: 'break-all' }}>
              {session.address}
            </div>
            <div style={{ marginTop: 10 }}>
              <Button variant="ghost" size="sm" onClick={() => void copyAddress()}>
                {t('common.copy')}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Claim a protected transfer sent to you */}
      <Card title={t('claim.title')}>
        <div>
          <Field
            label={t('claim.code')}
            error={
              secret && !parsed ? t('claim.codeInvalid') : noMatch ? t('claim.noMatch') : null
            }
            hint={!secret ? t('claim.codeHint') : undefined}
          >
            <Input
              mono
              invalid={Boolean(secret) && !parsed}
              value={secret}
              onChange={(e) => setSecret(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              data-testid="code-input"
            />
          </Field>
        </div>
        {matched && (
          <div className="row-between claim__picked" style={{ marginTop: 12 }}>
            <span>
              {t('claim.matched', {
                id: matched.transferId.toString(),
                amount: formatUnits(matched.transfer.amount, 6),
                from: short(matched.transfer.sender),
              })}
            </span>
          </div>
        )}
        <div className="row wrap" style={{ marginTop: 14 }}>
          <Button
            onClick={() => void guard(() => handleClaim(false))}
            loading={busy}
            disabled={busy || !session.onArc || !matched}
            data-testid="claim-button"
          >
            {busy ? t('claim.claiming') : t('claim.claimOwnGas')}
          </Button>
          {gaslessEnabled && (
            <Button
              variant="ghost"
              onClick={() => void guard(() => handleClaim(true))}
              disabled={busy}
              data-testid="gasless-claim-button"
            >
              {t('claim.claimGasless')}
            </Button>
          )}
        </div>
      </Card>

      {/* Inbox: protected transfers waiting for you */}
      <Card title={t('claim.pendingTitle')} data-testid="pending-list">
        {pending === null ? (
          <Skeleton height={56} />
        ) : pending.length === 0 ? (
          <p className="muted">{t('claim.pendingEmpty')}</p>
        ) : (
          pending.map(({ transferId, transfer }) => (
            <div className="trow trow--compact" key={transferId.toString()}>
              <div className="row-between">
                <div>
                  <div className="trow__idline">
                    <span className="trow__id">#{transferId.toString()}</span>
                    <span className="trow__sep">·</span>
                    <span className="trow__amount">{formatUnits(transfer.amount, 6)}</span>
                    <span className="trow__unit">USDC</span>
                  </div>
                  <div className="trow__to">← {short(transfer.sender)}</div>
                </div>
                {/* No select button: the code identifies its own transfer, so this
                    list is here to show what is waiting, not to be picked from. */}
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
