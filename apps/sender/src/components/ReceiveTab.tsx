import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { formatUnits, type Hex } from 'viem';
import { getPublicClient, supportsChain, type Session } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  Field,
  Input,
  NeedsChain,
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
import { findByClaimHash, type FoundTransfer } from '../lib/findByClaim.js';
import { signedPost } from '../lib/signedPost.js';
import { ReceivedTab } from './ReceivedTab.js';

// Gasless claims are signed server-side (/api/gasless-claim) so the relayer and
// Circle keys never reach the browser bundle. Non-secret flag only.
const gaslessEnabled = import.meta.env.VITE_GASLESS_ENABLED !== 'false';

/**
 * The relayer endpoint spends real gas, so it will not answer an anonymous caller:
 * it wants a signature over path + timestamp + body hash, which also quota-limits
 * each caller and makes a captured request single-use. That costs the recipient one
 * wallet signature, and no transaction.
 */
interface GaslessResult {
  ok?: boolean;
  txHash?: string;
  error?: { kind?: string; attemptsRemaining?: number; reason?: string; message?: string };
}

async function gaslessClaimViaServer(
  session: Session,
  transferId: bigint,
  code: string,
  salt: Hex,
): Promise<Hex> {
  const data = await signedPost<GaslessResult>(session, '/api/gasless-claim', {
    transferId: transferId.toString(),
    code,
    salt,
  });
  if (data.ok && data.txHash) return data.txHash as Hex;
  // A refused claim comes back as a typed reason, not an HTTP error, so it is
  // rebuilt into the same errors the direct path throws and the UI reports both
  // identically.
  const err = data.error;
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
  onSwitchChain,
}: {
  session: Session;
  pending: PendingClaim[] | null;
  reload: () => Promise<void>;
  balance: string;
  onClaimed: () => Promise<void> | void;
  onSwitchChain: (chainId: number) => Promise<void>;
}) {
  const t = useT();
  // The claim, the cancel and the refund are all one contract on one chain.
  const onSupportedChain = supportsChain(session.chainId, 'receive');
  const toast = useToast();
  const guard = useSubmitGuard();

  const [secret, setSecret] = useState('');
  // Which claim is running, not merely that one is. A single shared flag put the
  // spinner and the "Claiming" label on the left button no matter which was
  // pressed, so pressing "relayer pays" looked like the app had started the
  // other claim -- the one that spends the user's own gas.
  const [claiming, setClaiming] = useState<'own' | 'gasless' | null>(null);
  const busy = claiming !== null;
  /**
   * The settled claim, and who it actually paid.
   *
   * Not always the person pressing the button. A claim is permissionless and
   * always pays the recipient recorded at send time, which is the whole reason a
   * relayer can settle for someone with no gas, so the success screen cannot
   * assume the money landed here. It used to, and said "it reached your wallet"
   * next to the claimer's own balance while the funds went somewhere else.
   */
  const [claimed, setClaimed] = useState<{ tx: Hex; toSelf: boolean } | null>(null);
  const [qr, setQr] = useState('');

  // One string carries the whole proof, so the recipient types it and nothing else.
  // Deliberately not delivered by any address-keyed channel (chain, backend, push):
  // in a poisoning attack the recorded recipient is the attacker, so such a channel
  // would hand them the secret. It has to reach a human.
  const parsed = normaliseSecret(secret);

  // The secret says which transfer it belongs to: its commitment is on the chain, so
  // the app recomputes the hash and looks it up. No transfer number to type, and no
  // requirement to be connected as the recipient, because `claim` always pays the
  // recipient recorded at send time whoever submits it.
  const [lookup, setLookup] = useState<{ found: FoundTransfer | null; searching: boolean }>({
    found: null,
    searching: false,
  });
  /**
   * What the inbox holds, as a value rather than an array.
   *
   * The scan below is unindexed -- `claimHash` sits in the event data, not a topic
   * -- so a miss walks 200k blocks and takes the better part of a minute. Keying
   * the effect on the `pending` array itself restarted that walk every time the
   * 8-second poll returned a fresh array, which for a mistyped code left in the box
   * meant a permanent rescan. Keying it on the contents keeps the one behaviour
   * that identity was accidentally providing -- a code pasted before its transfer
   * lands gets matched when it does -- without the storm.
   */
  const inbox = (pending ?? []).map((p) => p.transfer.claimHash).join(',');
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    if (!parsed) {
      setLookup({ found: null, searching: false });
      return;
    }
    let live = true;
    setLookup({ found: null, searching: true });
    const want = hashClaim(saltFromSecret(parsed), parsed);
    const local = pendingRef.current?.find(
      (p) => p.transfer.claimHash.toLowerCase() === want.toLowerCase(),
    );
    if (local) {
      setLookup({
        found: {
          transferId: local.transferId,
          to: local.transfer.to,
          sender: local.transfer.sender,
          amount: local.transfer.amount,
          deadline: local.transfer.deadline.getTime(),
        },
        searching: false,
      });
      return;
    }
    findByClaimHash(getPublicClient(), want)
      .then((f) => live && setLookup({ found: f, searching: false }))
      .catch(() => live && setLookup({ found: null, searching: false }));
    return () => {
      live = false;
    };
  }, [parsed, inbox]);
  const matched = lookup.found;
  const noMatch = Boolean(parsed) && !lookup.searching && matched === null;
  // The contract refuses a claim once the window closes, so the app should say so
  // rather than offer a button that spends gas to revert.
  const expired = matched !== null && matched.deadline > 0 && matched.deadline <= Date.now();

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
    setClaiming(gasless ? 'gasless' : 'own');
    try {
      const tx = gasless
        ? await gaslessClaimViaServer(session, id, parsed, salt)
        : await claim(session.clients, id, parsed, salt);
      setClaimed({ tx, toSelf: matched.to.toLowerCase() === session.address.toLowerCase() });
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
      setClaiming(null);
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

  if (claimed) {
    return (
      <>
        {/* Confetti for money that arrived here. Settling someone else's transfer
            is a favour, not a windfall, and celebrating it would be celebrating a
            balance that did not change. */}
        {claimed.toSelf && <Confetti />}
        <Card data-testid="claim-success">
          <h2 className="card__title" style={{ color: 'var(--safe)' }}>
            {t(claimed.toSelf ? 'claim.successTitle' : 'claim.settledTitle')}
          </h2>
          <p className="muted">
            {claimed.toSelf
              ? t('claim.successBody', {
                  balance: Number(balance).toLocaleString(undefined, {
                    maximumFractionDigits: 4,
                  }),
                })
              : t('claim.settledBody')}
          </p>
          <a className="row" href={explorerTxUrl(claimed.tx)} target="_blank" rel="noreferrer">
            {t('common.viewOnArcScan')} <IconExternal width={14} height={14} />
          </a>
          <div style={{ marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setClaimed(null)}>
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
        {!onSupportedChain ? (
          <NeedsChain feature="receive" onSwitch={onSwitchChain} chainId={session.chainId} />
        ) : (
          <>
        <div>
          {/* The scan behind a code can take the better part of a minute, and a
              screen that says nothing for that long reads as a screen that did
              nothing. The hint carries the wait; the error carries the verdict. */}
          <Field
            label={t('claim.code')}
            error={
              secret && !parsed ? t('claim.codeInvalid') : noMatch ? t('claim.noMatch') : null
            }
            hint={
              !secret
                ? t('claim.codeHint')
                : lookup.searching
                  ? t('claim.searching')
                  : undefined
            }
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
              {expired
                ? t('claim.matchedExpired', { id: matched.transferId.toString() })
                : t('claim.matched', {
                    id: matched.transferId.toString(),
                    amount: formatUnits(matched.amount, 6),
                    from: short(matched.sender),
                  })}
            </span>
          </div>
        )}
        {/* `claim-actions` splits the row evenly so neither button is sized by its
            own label. The left one used to swap to "Claiming" mid-flight, shrink,
            and shove the gasless button sideways under the cursor. */}
        <div className="row wrap claim-actions" style={{ marginTop: 14 }}>
          <Button
            onClick={() => void guard(() => handleClaim(false))}
            loading={claiming === 'own'}
            disabled={busy || !matched || expired}
            data-testid="claim-button"
          >
            {t('claim.claimOwnGas')}
          </Button>
          {gaslessEnabled && (
            <Button
              variant="ghost"
              onClick={() => void guard(() => handleClaim(true))}
              loading={claiming === 'gasless'}
              disabled={busy || !matched || expired}
              data-testid="gasless-claim-button"
            >
              {t('claim.claimGasless')}
            </Button>
          )}
        </div>
          </>
        )}
      </Card>

      {/* Everything ever sent to this wallet, with what is still waiting as one
          filter of it. A separate "waiting" card would have been the same rows twice. */}
      <ReceivedTab session={session} />
    </div>
  );
}
