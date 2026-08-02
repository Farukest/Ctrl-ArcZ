import { useMemo, useState } from 'react';
import {
  parseUnits,
  formatUnits,
  isAddress,
  erc20Abi,
  createWalletClient,
  http,
  fallback,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ADDRESSES,
  RPC_URLS,
  arcTestnet,
  readAccount,
  submitPull,
  sweepToVault,
  RemoteCoSigner,
  MODE_PULL,
  ACTION_PULL,
  explorerAddressUrl,
  newStealthOwner,
  computeStealthPrivateKey,
} from '@ctrl-arcz/sdk';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import { getStealthKeys } from '../lib/stealthKeys.js';
import { relayCreateBox, relayAnnounceBox, relayStealthGas } from '../lib/relay.js';
import {
  Button,
  Card,
  Field,
  Input,
  Stepper,
  IconExternal,
  useSubmitGuard,
  useT,
  useToast,
  short,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { useSubscriptions, type Subscription, type SubStatus } from '../lib/useSubscriptions.js';
import { getLabel, setLabel } from '../lib/subscriptionLabels.js';

const USDC = ADDRESSES.USDC as Address;
const PAGE_SIZE = 5;

// Short intervals included so a pull can actually be re-triggered during a testnet demo.
const INTERVALS = [
  { secs: 60, key: 'min1' },
  { secs: 3600, key: 'hour1' },
  { secs: 86400, key: 'day1' },
  { secs: 604800, key: 'day7' },
  { secs: 2592000, key: 'day30' },
] as const;
const DURATIONS = [
  { secs: 86400, key: 'day1' },
  { secs: 604800, key: 'day7' },
  { secs: 2592000, key: 'day30' },
  { secs: 7776000, key: 'day90' },
] as const;

type SortKey = 'newest' | 'oldest' | 'amountHigh' | 'amountLow' | 'endsSoon';
type CreatePhase = 'idle' | 'machine' | 'creating' | 'funding' | 'done' | 'vetoed';

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as Hex;
}

const STATUS_COLOR: Record<SubStatus, string> = {
  active: 'var(--safe)',
  completed: 'var(--info)',
  cancelled: 'var(--text-lo)',
  expired: 'var(--warn)',
};

export function SubscriptionsTab({ session }: { session: Session }) {
  const t = useT();
  const toast = useToast();
  const guard = useSubmitGuard();
  const { subs, loading, reload } = useSubscriptions(session);

  // Create form
  const [label, setLbl] = useState('');
  const [target, setTarget] = useState('');
  const [perPull, setPerPull] = useState('0.02');
  const [cap, setCap] = useState('0.1');
  const [intervalSecs, setIntervalSecs] = useState<number>(60);
  const [durationSecs, setDurationSecs] = useState<number>(2592000);
  const [phase, setPhase] = useState<CreatePhase>('idle');
  const [veto, setVeto] = useState<string | null>(null);

  // List controls
  const [query, setQuery] = useState('');
  // Active by default. Cancelled and completed boxes accumulate forever and are
  // never what someone opening this tab came to see; the counts on the chips keep
  // the rest one click away.
  const [statusFilter, setStatusFilter] = useState<SubStatus | 'all'>('active');
  const [sort, setSort] = useState<SortKey>('newest');
  const [page, setPage] = useState(0);
  // Which box, and which action on it. One flag put the spinner on whichever
  // button happened to read it first, so pressing Cancel span "Pull now" -- the
  // opposite operation, on money.
  const [busy, setBusy] = useState<{ account: string; action: 'pull' | 'cancel' } | null>(null);
  const [openDetail, setOpenDetail] = useState<string | null>(null);

  const creating = phase !== 'idle' && phase !== 'done' && phase !== 'vetoed';
  /**
   * One operation at a time, across every row and the create form.
   *
   * Every box is pulled and swept by the same wallet, and each authorisation is
   * signed against the account's current `nonce`, read at the start. Two of these
   * running at once read the same nonce and the second signature is dead on
   * arrival -- or worse, both transactions go out and one silently replaces the
   * other. Locking per box was not enough, because the collision is between rows.
   */
  const locked = busy !== null || creating;
  // Recomputed each render, which is all the precision a "not yet" needs.
  const nowSec = Math.floor(Date.now() / 1000);

  const validTarget = isAddress(target);
  const perPullNum = Number(perPull);
  const capNum = Number(cap);
  const canCreate =
    validTarget &&
    perPullNum > 0 &&
    capNum >= perPullNum &&
    (phase === 'idle' || phase === 'done' || phase === 'vetoed');

  const createSteps: Step[] = useMemo(() => {
    const order: CreatePhase[] = ['machine', 'creating', 'funding'];
    const labels = [t('sub.step.machine'), t('sub.step.create'), t('sub.step.fund')];
    const active = order.indexOf(phase);
    return labels.map((l, i) => ({
      label: l,
      status:
        phase === 'done' ? 'done' : active < 0 ? 'pending' : i < active ? 'done' : i === active ? 'active' : 'pending',
    }));
  }, [phase, t]);

  async function create() {
    setVeto(null);
    const clients = session.clients;
    const owner = session.address as Address;
    const to = target as Address;
    const perPullAmt = parseUnits(perPull, 6);
    const capAmt = parseUnits(cap, 6);
    try {
      const cosignerAddress = (await fetch('/api/cosign').then((r) => r.json())).address as Address;
      const cosigner = new RemoteCoSigner('/api/cosign', cosignerAddress, undefined, {
        address: owner,
        sign: (message) =>
          clients.walletClient.signMessage({ account: clients.walletClient.account!, message }),
      });
      const salt = randomSalt();
      const expiry = Math.floor(Date.now() / 1000) + durationSecs;

      // 1. Firewall the merchant before anything is created.
      setPhase('machine');
      const pre = await cosigner.precheck({ owner, target: to, amount: perPullAmt });
      if (!pre.approved) {
        setVeto(pre.reason);
        setPhase('vetoed');
        toast.push(t('sub.vetoedToast'), 'error');
        return;
      }

      // 2. A fresh stealth owner: the box is owned AND vaulted by a one-time address
      //    with no keccak(yourWallet) tag, so an observer who knows your address
      //    cannot confirm which boxes are yours. You rediscover them by scanning the
      //    announcer with your viewing key.
      const keys = await getStealthKeys(session);
      const stealth = newStealthOwner(keys);

      // 3. Deploy the PULL box with the policy: per-pull cap, interval, total cap,
      //    expiry. Submitted by the relayer, not by this wallet: the deploy names
      //    whoever sends it, and there is no reason for that to be the payer. The
      //    address is verified against our own prediction afterwards, so a relayer
      //    that deployed something else is caught here rather than at funding.
      setPhase('creating');
      const policy = {
        token: USDC,
        owner: stealth.stealthAddress,
        cosigner: cosignerAddress,
        vault: stealth.stealthAddress,
        target: to,
        maxAmount: capAmt,
        perPullMax: perPullAmt,
        expiry,
        interval: intervalSecs,
        mode: MODE_PULL,
      } as const;
      const { account } = await relayCreateBox(session, salt, policy);

      // 4. Fund the box with the total budget.
      setPhase('funding');
      const fundHash = await clients.walletClient.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [account, capAmt],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain ?? null,
      });
      await clients.publicClient.waitForTransactionReceipt({ hash: fundHash });

      // 5. Announce it so only your viewing key can rediscover this box. Also
      //    relayed: `StealthAnnouncer` indexes msg.sender, so announcing from this
      //    wallet would publish "this address created a stealth box" and undo the
      //    point of the fresh owner.
      await relayAnnounceBox(session, stealth, account);

      if (label.trim()) setLabel(account, label);
      setPhase('done');
      toast.push(t('sub.createdToast'), 'success');
      setLbl('');
      setTarget('');
      setSort('newest');
      setStatusFilter('all');
      setPage(0);
      await reload(account);
    } catch (e) {
      setPhase('idle');
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function pullNow(sub: Subscription) {
    setBusy({ account: sub.account, action: 'pull' });
    const clients = session.clients;
    const owner = session.address as Address;
    try {
      const cosignerAddress = (await fetch('/api/cosign').then((r) => r.json())).address as Address;
      const cosigner = new RemoteCoSigner('/api/cosign', cosignerAddress, undefined, {
        address: owner,
        sign: (message) =>
          clients.walletClient.signMessage({ account: clients.walletClient.account!, message }),
      });
      const state = await readAccount(clients.publicClient, sub.account);
      const chainId = await clients.publicClient.getChainId();
      const auth = await cosigner.authorize({
        account: sub.account,
        owner,
        amount: sub.pullableNow,
        action: ACTION_PULL,
        target: state.target,
        nonce: state.nonce,
        chainId,
        remaining: state.remaining,
        expiry: state.expiry,
        perPullMax: state.perPullMax,
        interval: state.interval,
        lastPull: state.lastPull,
      });
      if (!auth.approved) {
        toast.push(auth.reason, 'error');
        return;
      }
      await submitPull(clients, sub.account, sub.pullableNow, auth.signature);
      toast.push(t('sub.pulledToast'), 'success');
      await reload();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function cancel(sub: Subscription) {
    if (!window.confirm(t('sub.cancelConfirm'))) return;
    setBusy({ account: sub.account, action: 'cancel' });
    try {
      if (sub.ephemeralPubKey) {
        // Stealth box: the vault is a fresh stealth address only we can derive. On
        // Arc gas is USDC, so the vault needs a little gas before it can sign the
        // sweep. That top-up comes from the relayer, not from this wallet: paying it
        // ourselves would write "this wallet funded that stealth address" on chain,
        // which is precisely the link the stealth address exists to avoid.
        const keys = await getStealthKeys(session);
        const stealthPriv = computeStealthPrivateKey({
          spendingKey: keys.spendingKey,
          viewingKey: keys.viewingKey,
          ephemeralPubKey: sub.ephemeralPubKey,
        });
        const stealthAccount = privateKeyToAccount(stealthPriv);
        const publicClient = getPublicClient();

        await relayStealthGas(session, stealthAccount.address);

        const stealthWallet = createWalletClient({
          account: stealthAccount,
          chain: arcTestnet,
          transport: fallback(RPC_URLS.map((u) => http(u))),
        });
        await sweepToVault({ publicClient, walletClient: stealthWallet }, sub.account, stealthAccount.address);
      } else {
        // Legacy box: the vault is your own wallet, which sweeps directly.
        await sweepToVault(session.clients, sub.account, session.address as Address);
      }
      toast.push(t('sub.cancelledToast'), 'success');
      await reload();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  // Filter + search + sort + paginate (client-side).
  const filtered = useMemo(() => {
    let list = subs ?? [];
    if (statusFilter !== 'all') list = list.filter((s) => s.status === statusFilter);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.target.toLowerCase().includes(q) ||
          s.account.toLowerCase().includes(q) ||
          getLabel(s.account).toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return a.account < b.account ? -1 : 1;
        case 'amountHigh':
          return a.cap > b.cap ? -1 : a.cap < b.cap ? 1 : 0;
        case 'amountLow':
          return a.cap < b.cap ? -1 : a.cap > b.cap ? 1 : 0;
        case 'endsSoon':
          return a.expiry - b.expiry;
        case 'newest':
        default:
          return a.account > b.account ? -1 : 1;
      }
    });
    return sorted;
  }, [subs, statusFilter, query, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  const counts = useMemo(() => {
    const c = { all: subs?.length ?? 0, active: 0, completed: 0, cancelled: 0, expired: 0 };
    for (const s of subs ?? []) c[s.status]++;
    return c;
  }, [subs]);

  return (
    <>
      {/* CREATE */}
      <Card title={t('sub.createTitle')} data-testid="sub-create">
        <p className="muted" style={{ marginTop: 0 }}>
          {t('sub.createSummary')}
        </p>
        <div className="formstack">
          <div className="sub-grid">
            <Field label={t('sub.label')}>
              <Input value={label} onChange={(e) => setLbl(e.target.value)} placeholder={t('sub.labelPh')} data-testid="sub-label" />
            </Field>
            <Field label={t('sub.merchant')} error={target.length > 0 && !validTarget ? t('send.invalidAddress') : null}>
              <Input mono value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x…" data-testid="sub-target" invalid={target.length > 0 && !validTarget} spellCheck={false} autoComplete="off" />
            </Field>
          </div>
          <div className="sub-grid">
            <Field label={t('sub.perPull')}>
              <Input value={perPull} onChange={(e) => setPerPull(e.target.value)} inputMode="decimal" data-testid="sub-perpull" />
            </Field>
            <Field label={t('sub.cap')} error={capNum > 0 && capNum < perPullNum ? t('sub.capTooLow') : null}>
              <Input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" data-testid="sub-cap" invalid={capNum > 0 && capNum < perPullNum} />
            </Field>
          </div>
          <div className="sub-grid">
            <Field label={t('sub.interval')}>
              <select className="sub-select" value={intervalSecs} onChange={(e) => setIntervalSecs(Number(e.target.value))} data-testid="sub-interval">
                {INTERVALS.map((iv) => (
                  <option key={iv.key} value={iv.secs}>
                    {t(`sub.iv.${iv.key}` as never)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('sub.duration')}>
              <select className="sub-select" value={durationSecs} onChange={(e) => setDurationSecs(Number(e.target.value))} data-testid="sub-duration">
                {DURATIONS.map((d) => (
                  <option key={d.key} value={d.secs}>
                    {t(`sub.iv.${d.key}` as never)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button onClick={() => void guard(create)} disabled={!canCreate || busy !== null} loading={creating} data-testid="sub-submit">
            {t('sub.createButton')}
          </Button>
          {phase !== 'idle' && phase !== 'vetoed' && <Stepper steps={createSteps} />}
          {veto && (
            <div className="veto" data-testid="sub-veto">
              <div className="veto__reason" style={{ color: 'var(--block)' }}>
                {t('sub.vetoTitle')}: {veto}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* LIST */}
      <Card title={t('sub.listTitle')} data-testid="sub-list">
        <div className="sub-toolbar">
          <Input className="grow" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder={t('sub.searchPh')} data-testid="sub-search" />
          <select className="sub-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} data-testid="sub-sort">
            <option value="newest">{t('sub.sort.newest')}</option>
            <option value="oldest">{t('sub.sort.oldest')}</option>
            <option value="amountHigh">{t('sub.sort.amountHigh')}</option>
            <option value="amountLow">{t('sub.sort.amountLow')}</option>
            <option value="endsSoon">{t('sub.sort.endsSoon')}</option>
          </select>
        </div>
        <div className="sub-chips" data-testid="sub-filters">
          {(['all', 'active', 'completed', 'cancelled', 'expired'] as const).map((s) => (
            <button key={s} type="button" className={`sub-chip ${statusFilter === s ? 'sub-chip--on' : ''}`} onClick={() => { setStatusFilter(s); setPage(0); }} data-testid={`sub-chip-${s}`}>
              {t(`sub.filter.${s}` as never)} <span className="sub-chip__n">{counts[s]}</span>
            </button>
          ))}
        </div>

        {subs === null || (loading && subs.length === 0) ? (
          <p className="muted">{t('common.loading')}</p>
        ) : filtered.length === 0 ? (
          <p className="muted" data-testid="sub-empty">{t('sub.empty')}</p>
        ) : (
          <>
            {pageItems.map((s) => {
              const name = getLabel(s.account);
              const pct = s.cap > 0n ? Number((s.spent * 100n) / s.cap) : 0;
              const open = openDetail === s.account;
              const mine = busy?.account === s.account;
              // Why the pull is unavailable, in words, instead of a dead button.
              const pullHint =
                s.pullableNow > 0n
                  ? undefined
                  : s.status !== 'active'
                    ? t(`sub.filter.${s.status}` as never)
                    : nowSec < s.nextPullAt
                      ? t('sub.nextPullAt', { when: new Date(s.nextPullAt * 1000).toLocaleTimeString() })
                      : s.balance === 0n
                        ? t('sub.notFundedYet')
                        : t('sub.budgetSpent');
              return (
                <div className="sub-row" key={s.account} data-testid="sub-item">
                  <div className="row-between">
                    <div style={{ minWidth: 0 }}>
                      <div className="sub-row__head">
                        <span className="sub-row__name">{name || short(s.target)}</span>
                        <span className="sub-badge" style={{ color: STATUS_COLOR[s.status], borderColor: STATUS_COLOR[s.status] }}>
                          {t(`sub.filter.${s.status}` as never)}
                        </span>
                      </div>
                      <div className="sub-row__meta">
                        {formatUnits(s.perPull, 6)} USDC / {t(`sub.iv.${intervalKeyOf(s.interval)}` as never)}
                        <span className="sub-row__sep">·</span>
                        {t('sub.remaining')}: {formatUnits(s.remaining, 6)}/{formatUnits(s.cap, 6)}
                      </div>
                      <div className="sub-bar"><span style={{ width: `${pct}%` }} /></div>
                    </div>
                    <div className="sub-row__actions">
                      <Button variant="ghost" size="sm" onClick={() => setOpenDetail(open ? null : s.account)} data-testid="sub-detail-toggle">
                        {t('sub.details')}
                      </Button>
                      {s.status === 'active' && (
                        <>
                          <Button size="sm" title={pullHint} disabled={locked || s.pullableNow === 0n} loading={mine && busy?.action === 'pull'} onClick={() => void guard(() => pullNow(s))} data-testid="sub-pull">
                            {s.pullableNow > 0n ? t('sub.pullNow') : t('sub.tooSoon')}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={locked} loading={mine && busy?.action === 'cancel'} onClick={() => void guard(() => cancel(s))} data-testid="sub-cancel">
                            {t('sub.cancel')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {open && <SubDetail sub={s} name={name} onLabel={(v) => { setLabel(s.account, v); void reload(); }} />}
                </div>
              );
            })}

            {pageCount > 1 && (
              <div className="sub-pager" data-testid="sub-pager">
                <Button variant="ghost" size="sm" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)} data-testid="sub-prev">
                  {t('common.prev')}
                </Button>
                <span className="muted">{clampedPage + 1} / {pageCount}</span>
                <Button variant="ghost" size="sm" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)} data-testid="sub-next">
                  {t('common.next')}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function intervalKeyOf(secs: number): string {
  const m = INTERVALS.find((iv) => iv.secs === secs);
  return m ? m.key : 'day30';
}

function fmtTime(unix: number): string {
  try {
    return new Date(unix * 1000).toLocaleString();
  } catch {
    return String(unix);
  }
}

function SubDetail({
  sub,
  name,
  onLabel,
}: {
  sub: Subscription;
  name: string;
  onLabel: (v: string) => void;
}) {
  const t = useT();
  const [edit, setEdit] = useState(name);
  const now = Math.floor(Date.now() / 1000);
  const nextIn = Math.max(0, sub.nextPullAt - now);
  return (
    <div className="sub-detail" data-testid="sub-detail">
      <dl className="sub-dl">
        <div><dt>{t('sub.d.account')}</dt><dd className="mono">{sub.account}</dd></div>
        <div><dt>{t('sub.d.merchant')}</dt><dd className="mono">{sub.target}</dd></div>
        <div><dt>{t('sub.d.perPull')}</dt><dd>{formatUnits(sub.perPull, 6)} USDC</dd></div>
        <div><dt>{t('sub.d.cap')}</dt><dd>{formatUnits(sub.cap, 6)} USDC</dd></div>
        <div><dt>{t('sub.d.spent')}</dt><dd>{formatUnits(sub.spent, 6)} USDC</dd></div>
        <div><dt>{t('sub.d.remaining')}</dt><dd>{formatUnits(sub.remaining, 6)} USDC</dd></div>
        <div><dt>{t('sub.d.balance')}</dt><dd>{formatUnits(sub.balance, 6)} USDC</dd></div>
        <div><dt>{t('sub.d.lastPull')}</dt><dd>{sub.lastPull === 0 ? t('sub.d.never') : fmtTime(sub.lastPull)}</dd></div>
        <div><dt>{t('sub.d.nextPull')}</dt><dd>{sub.status !== 'active' ? '—' : nextIn === 0 ? t('sub.d.now') : fmtTime(sub.nextPullAt)}</dd></div>
        <div><dt>{t('sub.d.expiry')}</dt><dd>{fmtTime(sub.expiry)}</dd></div>
      </dl>
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <Input className="grow" value={edit} onChange={(e) => setEdit(e.target.value)} placeholder={t('sub.labelPh')} data-testid="sub-label-edit" />
        <Button variant="ghost" size="sm" onClick={() => onLabel(edit)} data-testid="sub-label-save">{t('common.save')}</Button>
        <a className="row" href={explorerAddressUrl(sub.account)} target="_blank" rel="noreferrer">
          {t('common.viewOnArcScan')} <IconExternal width={13} height={13} />
        </a>
      </div>
    </div>
  );
}
