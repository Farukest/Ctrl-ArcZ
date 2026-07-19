import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatUnits, type Address, type Hex } from 'viem';
import { useSession, getPublicClient } from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  ConnectBar,
  Field,
  Input,
  Skeleton,
  TopBar,
  useSubmitGuard,
  useT,
  useToast,
  short,
  IconExternal,
} from '@ctrl-arcz/demo-kit/ui';
import {
  claim,
  ctrlArcZAbi,
  CTRL_ARCZ_ADDRESS,
  explorerTxUrl,
  getLogsChunked,
  getTransfer,
  TransferLockedError,
  TransferUnavailableError,
  WrongClaimCodeError,
  type ProtectedTransfer,
  type TransferUnavailableReason,
} from '@ctrl-arcz/sdk';
import { Confetti } from './Confetti.js';

// Gasless claims are signed server-side (/api/gasless-claim) so the relayer and
// Circle keys never reach the browser bundle. This is only a non-secret flag that
// decides whether to offer the gasless button.
const gaslessEnabled = import.meta.env.VITE_GASLESS_ENABLED !== 'false';

/**
 * Ask the server to sponsor and submit the claim. The endpoint returns a plain
 * result; rebuild the SDK's typed errors so the existing `catch` reports identical
 * messages to the direct (own-gas) path.
 */
async function gaslessClaimViaServer(transferId: bigint, code: string, salt: Hex): Promise<Hex> {
  const res = await fetch('/api/gasless-claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transferId: transferId.toString(), code, salt }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    txHash?: string;
    error?:
      { kind: string; attemptsRemaining?: number; reason?: string; message?: string } | string;
  };
  if (res.ok && data.ok && data.txHash) return data.txHash as Hex;
  const err = data.error;
  // Validation/guard failures (400/403/…) return a plain string error.
  if (typeof err === 'string') throw new Error(err);
  const zero = `0x${'0'.repeat(64)}` as Hex;
  if (err?.kind === 'wrong_code')
    throw new WrongClaimCodeError(transferId, err.attemptsRemaining ?? 0, zero);
  if (err?.kind === 'locked') throw new TransferLockedError(transferId, zero);
  if (err?.kind === 'unavailable')
    throw new TransferUnavailableError((err.reason ?? 'not_pending') as TransferUnavailableReason);
  throw new Error(err?.message ?? 'gasless claim failed');
}

interface Pending {
  transferId: bigint;
  transfer: ProtectedTransfer;
}

export function App() {
  const state = useSession();
  const toast = useToast();
  const t = useT();
  const guard = useSubmitGuard();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [tid, setTid] = useState(params.get('tid') ?? '');
  // The claim code is NEVER read from the URL: a link carrying it would leak the
  // secret into browser history, Referer headers, and chat link previews, defeating
  // the out-of-band-code design. The recipient always types it in by hand. Only the
  // non-secret transfer id and salt (which the sender shares via QR) come from the URL.
  const [code, setCode] = useState('');
  const salt = params.get('salt') as Hex | null;

  const [pending, setPending] = useState<Pending[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimedTx, setClaimedTx] = useState<Hex | null>(null);

  const loadPending = useCallback(async () => {
    if (!state.session) return;
    const client = getPublicClient();
    const me = state.session.address.toLowerCase();
    try {
      const logs = await getLogsChunked<{ to?: Address; transferId?: bigint }>(client, {
        address: CTRL_ARCZ_ADDRESS,
        abi: ctrlArcZAbi,
        eventName: 'TransferCreated',
        args: { to: state.session.address as Address },
      });
      const ids = [
        ...new Set(
          logs
            .filter((l) => l.args.to?.toLowerCase() === me)
            .map((l) => l.args.transferId?.toString())
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const resolved = await Promise.all(
        ids.map(async (id) => ({
          transferId: BigInt(id),
          transfer: await getTransfer({ publicClient: client }, BigInt(id)).catch(() => null),
        })),
      );
      setPending(
        resolved
          .filter((r): r is Pending => r.transfer !== null && r.transfer.status === 'PENDING')
          .sort((a, b) => Number(b.transferId - a.transferId)),
      );
    } catch {
      setPending([]);
    }
  }, [state.session]);

  useEffect(() => {
    void loadPending();
    const timer = setInterval(() => void loadPending(), 8000);
    return () => clearInterval(timer);
  }, [loadPending]);

  const codeValid = /^\d{6}$/.test(code);

  async function handleClaim(gasless: boolean) {
    if (!state.session) return;
    if (!tid) return toast.push(t('claim.needTid'), 'error');
    if (!salt) return toast.push(t('claim.needSalt'), 'error');
    if (!codeValid) return toast.push(t('claim.codeInvalid'), 'error');

    setBusy(true);
    try {
      const tx = gasless
        ? await gaslessClaimViaServer(BigInt(tid), code, salt)
        : await claim(state.session.clients, BigInt(tid), code, salt);
      setClaimedTx(tx);
      await state.refreshBalance();
      await loadPending();
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

  if (claimedTx) {
    return (
      <main className="app-shell">
        <Confetti />
        <TopBar />
        <Card data-testid="claim-success">
          <h2 className="card__title" style={{ color: 'var(--safe)' }}>
            {t('claim.successTitle')}
          </h2>
          <p className="muted">
            {t('claim.successBody', {
              balance: Number(state.balance).toLocaleString(undefined, {
                maximumFractionDigits: 4,
              }),
            })}
          </p>
          <a className="row" href={explorerTxUrl(claimedTx)} target="_blank" rel="noreferrer">
            {t('common.viewOnArcScan')} <IconExternal width={14} height={14} />
          </a>
        </Card>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <TopBar />
      <p className="subtitle">{t('receiver.subtitle')}</p>

      <ConnectBar state={state} />

      {state.session && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Card title={t('claim.title')}>
            <Field label={t('claim.transferId')}>
              <Input
                mono
                value={tid}
                onChange={(e) => setTid(e.target.value.replace(/\D/g, ''))}
                placeholder="8"
                inputMode="numeric"
                data-testid="tid-input"
              />
            </Field>
            <div style={{ marginTop: 12 }}>
              <Field
                label={t('claim.code')}
                error={code && !codeValid ? t('claim.codeInvalid') : null}
                hint={!salt ? t('claim.needLink') : undefined}
              >
                <Input
                  mono
                  invalid={Boolean(code) && !codeValid}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  inputMode="numeric"
                  data-testid="code-input"
                />
              </Field>
            </div>

            <div className="row wrap" style={{ marginTop: 14 }}>
              <Button
                onClick={() => void guard(() => handleClaim(false))}
                loading={busy}
                disabled={busy || !state.session.onArc}
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
            {gaslessEnabled && (
              <>
                <hr className="rule" />
                <ul className="hintlist" style={{ marginTop: 0 }}>
                  <li>{t('claim.gasless1')}</li>
                  <li>{t('claim.gasless2')}</li>
                </ul>
              </>
            )}
          </Card>

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
                    <Button variant="ghost" size="sm" onClick={() => setTid(transferId.toString())}>
                      {t('common.select')}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      )}
    </main>
  );
}
