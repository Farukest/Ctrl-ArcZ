import { useMemo, useState } from 'react';
import {
  parseUnits,
  formatUnits,
  isAddress,
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
  fundEphemeral,
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
import { relayCreateBox, relayStealthGas } from '../lib/relay.js';
import {
  Button,
  Card,
  HistoryList,
  HistoryRow,
  Address as AddressChip,
  Field,
  Input,
  Select,
  Stepper,
  IconExternal,
  useSubmitGuard,
  useT,
  useToast,
  short,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { useSubscriptions, type Subscription, type SubStatus } from '../lib/useSubscriptions.js';
import { useRecipientGate } from '../lib/useRecipientGate.js';
import { RiskGate } from './RiskGate.js';
import { displayLabel, localLabel, setLabel } from '../lib/subscriptionLabels.js';

const USDC = ADDRESSES.USDC as Address;
const PAGE_SIZE = 5;

// Short intervals included so a pull can actually be re-triggered during a testnet demo.
/**
 * How often a merchant may charge, in the words people use for subscriptions.
 *
 * The form used to ask for a per-pull cap, an interval, a total budget and an
 * expiry as four independent fields, and left the arithmetic between them to the
 * user. Nobody thinks "0.02 every minute with a 0.1 budget"; they think "1 a week,
 * twelve times". Frequency and a count say the same thing to the contract and are
 * the two numbers a person actually has in mind.
 */
const FREQUENCIES = [
  { key: 'minute', secs: 60 },
  { key: 'daily', secs: 86_400 },
  { key: 'weekly', secs: 604_800 },
  { key: 'monthly', secs: 2_592_000 },
  { key: 'yearly', secs: 31_536_000 },
] as const;

type FrequencyKey = (typeof FREQUENCIES)[number]['key'];

/** Keeps a typo from funding a box with a thousand charges' worth of USDC. */
const MAX_CHARGES = 260;

type SortKey = 'newest' | 'oldest' | 'amountHigh' | 'amountLow' | 'endsSoon';
type CreatePhase = 'idle' | 'machine' | 'creating' | 'funding' | 'listing' | 'done' | 'vetoed';

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

/** Name, merchant and box address: the three things someone searches a box by. */
function subHaystack(s: Subscription): string {
  // Search matches whichever name is on screen, plus the announced one, so typing
  // a name that a different device set still finds the row.
  return `${displayLabel(s.account, s.announcedLabel)} ${s.announcedLabel} ${s.target} ${s.account}`;
}

export function SubscriptionsTab({ session }: { session: Session }) {
  const t = useT();
  const toast = useToast();
  const guard = useSubmitGuard();
  const { subs, loading, reload, track, stealthLocked, unlockStealth } = useSubscriptions(session);

  // Create form
  const [label, setLbl] = useState('');
  const [target, setTarget] = useState('');
  const [perPull, setPerPull] = useState('0.02');
  const [frequency, setFrequency] = useState<FrequencyKey>('minute');
  const [charges, setCharges] = useState('5');
  const [phase, setPhase] = useState<CreatePhase>('idle');
  const [veto, setVeto] = useState<string | null>(null);

  // List controls
  // Active by default. Cancelled and completed boxes accumulate forever and are
  // never what someone opening this tab came to see; the counts on the chips keep
  // the rest one click away.
  const [statusFilter, setStatusFilter] = useState<SubStatus | 'all'>('active');
  const [sort, setSort] = useState<SortKey>('newest');
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
  const chargeCount = Math.floor(Number(charges));
  const intervalSecs = FREQUENCIES.find((f) => f.key === frequency)?.secs ?? 60;
  /**
   * The budget is the whole point of the box, but it is not a question: it is the
   * charge times how many of them are allowed. Asking for it separately let
   * someone fund 0.1 against 0.03 charges, get three pulls, and leave 0.01 stranded
   * with nothing on screen saying so.
   */
  const capNum = perPullNum > 0 && chargeCount > 0 ? perPullNum * chargeCount : 0;
  /**
   * Expiry covers every charge with one interval to spare. The first is allowed
   * immediately and the last falls at `(count - 1) x interval`, so a full interval
   * of slack means a late final pull does not fall off the end.
   */
  const durationSecs = chargeCount > 0 ? chargeCount * intervalSecs : intervalSecs;
  /**
   * The count field names the unit it is counting. One charge per interval means
   * the number is both, so "How many months" says what "How many charges" made
   * the reader work out: how long this runs for.
   */
  const unit = t(`sub.unit.${frequency}` as never);
  const unitOne = t(`sub.unitOne.${frequency}` as never);
  const countError =
    charges.trim() === '' || chargeCount < 1
      ? t('sub.countTooLow', { unit: unitOne })
      : chargeCount > MAX_CHARGES
        ? t('sub.countTooHigh', { max: MAX_CHARGES, unit })
        : null;

  /**
   * The same firewall, on the merchant, before a box exists.
   *
   * This screen has more riding on the address than any other: a subscription is
   * not one payment to it, it is standing permission to pull from a funded box on
   * a schedule. The co-signer vetoes a bad merchant at create time, but that
   * verdict used to arrive only after the user had set a budget, an interval and
   * an expiry and pressed the button. Showing it while they type costs a scan
   * they were going to pay for anyway.
   */
  const gate = useRecipientGate(session, target);

  const canCreate =
    validTarget &&
    perPullNum > 0 &&
    countError === null &&
    gate.armed &&
    (phase === 'idle' || phase === 'done' || phase === 'vetoed');

  const createSteps: Step[] = useMemo(() => {
    const order: CreatePhase[] = ['machine', 'creating', 'funding', 'listing'];
    const labels = [
      t('sub.step.machine'),
      t('sub.step.create'),
      t('sub.step.fund'),
      t('sub.step.listing'),
    ];
    const active = order.indexOf(phase);
    return labels.map((l, i) => ({
      label: l,
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

  async function create() {
    setVeto(null);
    const clients = session.clients;
    const owner = session.address as Address;
    const to = target as Address;
    const perPullAmt = parseUnits(perPull, 6);
    // Derived, not typed: charge times count, to the same 6 decimals the contract
    // uses. Computing it in floats and formatting back would round a budget the
    // user never chose.
    const capAmt = perPullAmt * BigInt(chargeCount);
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
      // Deployed and announced in one relayed call, on one signature. Announcing
      // separately afterwards cost a second wallet dialog for the other half of an
      // action the user had already approved.
      const { account } = await relayCreateBox(session, salt, policy, {
        ...stealth,
        // Announced with the box, so this name follows it to every device instead
        // of living in the browser that happened to create it.
        label: label.trim(),
      });

      // 4. Fund the box with the total budget. The only transaction this wallet
      //    signs in the whole flow, and the only step that moves the user's money.
      //
      //    Through the SDK rather than a raw transfer, because `fundEphemeral` reads
      //    the deployed policy back off chain and refuses to pay a box whose target,
      //    co-signer, vault, caps, interval, expiry or mode is not the one we asked
      //    for. The relayer deploys this box, so that check is the difference between
      //    trusting it and verifying it.
      setPhase('funding');
      await fundEphemeral(clients, account, capAmt, policy);

      // We made this box; there is nothing to discover about it. Registering and
      // rendering it here is what stops the list waiting on an RPC log index.
      // No local label is written: the name went out with the announcement.
      // Land on Active, where the thing just created actually is. This used to
      // switch to All, which drops a brand-new subscription into a list led by
      // every cancelled box the wallet has ever had.
      setStatusFilter('active');
      setSort('newest');
      setPhase('listing');
      await track(account, stealth.ephemeralPubKey, label.trim());

      // Only now is the row on screen, so only now is the step list finished.
      // Marking it done before this left the user watching a completed progress
      // indicator above a list that did not yet contain what it had just made.
      setPhase('done');
      toast.push(t('sub.createdToast'), 'success');
      setLbl('');
      setTarget('');
      // The slow scans, after the user already has what they asked for.
      void reload(account);
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
        await sweepToVault(
          { publicClient, walletClient: stealthWallet },
          sub.account,
          stealthAccount.address,
        );
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

  // Status and sort are this screen's; search, date and paging belong to the list.
  const filtered = useMemo(() => {
    let list = subs ?? [];
    if (statusFilter !== 'all') list = list.filter((s) => s.status === statusFilter);
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return a.discoveredAt - b.discoveredAt;
        case 'amountHigh':
          return a.cap > b.cap ? -1 : a.cap < b.cap ? 1 : 0;
        case 'amountLow':
          return a.cap < b.cap ? -1 : a.cap > b.cap ? 1 : 0;
        case 'endsSoon':
          return a.expiry - b.expiry;
        case 'newest':
        default:
          // Discovery order, which follows the announcement logs and so follows
          // time. This compared addresses, which are derived from a salt: the list
          // was ordered by a hash while telling the user it was ordered by age.
          return b.discoveredAt - a.discoveredAt;
      }
    });
    return sorted;
  }, [subs, statusFilter, sort]);

  const counts = useMemo(() => {
    const c = { all: subs?.length ?? 0, active: 0, completed: 0, cancelled: 0, expired: 0 };
    for (const s of subs ?? []) c[s.status]++;
    return c;
  }, [subs]);

  return (
    <>
      {/* CREATE */}
      <Card
        title={t('sub.createTitle')}
        infoLabel={t('sub.createTitle')}
        info={<p>{t('sub.createSummary')}</p>}
        data-testid="sub-create"
      >
        <div className="formstack">
          <div className="sub-grid">
            <Field label={t('sub.label')}>
              <Input
                value={label}
                onChange={(e) => setLbl(e.target.value)}
                placeholder={t('sub.labelPh')}
                data-testid="sub-label"
              />
            </Field>
            <Field
              label={t('sub.merchant')}
              error={target.length > 0 && !validTarget ? t('send.invalidAddress') : null}
            >
              <Input
                mono
                value={target}
                onChange={(e) => setTarget(e.target.value.trim())}
                placeholder="0x…"
                data-testid="sub-target"
                invalid={target.length > 0 && !validTarget}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          </div>
          {/* Outside the two-column grid on purpose: a verdict is prose and needs
              the full width, and as a grid child it was squeezed into one column
              beside an empty cell. */}
          <RiskGate gate={gate} overridable={false} recoverable={false} data-testid="sub-risk" />
          <div className="sub-grid">
            <Field label={t('sub.perPull')}>
              <Input
                value={perPull}
                onChange={(e) => setPerPull(e.target.value)}
                inputMode="decimal"
                data-testid="sub-perpull"
              />
            </Field>
            <Field label={t('sub.frequency')}>
              <Select
                value={frequency}
                options={FREQUENCIES.map((f) => ({
                  value: f.key,
                  label: t(`sub.freq.${f.key}` as never),
                }))}
                onChange={(v: string) => setFrequency(v as FrequencyKey)}
                ariaLabel={t('sub.frequency')}
                full
              />
            </Field>
          </div>
          <div className="sub-grid">
            <Field label={t('sub.count', { unit })} error={countError}>
              <Input
                value={charges}
                onChange={(e) => setCharges(e.target.value)}
                inputMode="numeric"
                invalid={countError !== null}
                data-testid="sub-count"
              />
            </Field>
            {/* The budget and the end date used to be things to fill in. They are
                answers, not questions, so they are shown rather than asked. */}
            <Field label={t('sub.total')}>
              <output className="sub-total" data-testid="sub-total">
                {capNum > 0 ? `${trimAmount(capNum)} USDC` : '—'}
              </output>
            </Field>
          </div>
          {canCreate && (
            <p className="muted sub-summary" data-testid="sub-summary">
              {t('sub.summary', {
                total: trimAmount(capNum),
                count: chargeCount,
                perPull: trimAmount(perPullNum),
                freq: t(`sub.freq.${frequency}` as never),
                date: fmtTime(Math.floor(Date.now() / 1000) + durationSecs),
              })}
            </p>
          )}
          {frequency === 'minute' && (
            <p className="muted sub-summary">{t('sub.freq.minuteNote')}</p>
          )}
          <Button
            onClick={() => void guard(create)}
            disabled={!canCreate || busy !== null}
            loading={creating}
            data-testid="sub-submit"
          >
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
      {/* The stealth explanation sits behind the title's `i`. It answers a real
          question -- why a payments app is asking for a signature to show a list --
          but it answers it for the people who ask, and it was four lines above the
          list for everybody. The locked state below is not an explanation, it is
          the one thing standing between the user and their subscriptions, so that
          stays where it cannot be missed. */}
      <Card
        title={t('sub.listTitle')}
        infoLabel={t('sub.listTitle')}
        info={<p>{t('sub.stealthNote')}</p>}
        data-testid="sub-list"
      >
        {stealthLocked ? (
          <div className="veto" data-testid="sub-stealth-locked">
            <div className="veto__reason">{t('sub.stealthLocked')}</div>
            <div style={{ marginTop: 8 }}>
              <Button
                size="sm"
                onClick={() => void unlockStealth()}
                data-testid="sub-stealth-unlock"
              >
                {t('sub.stealthUnlock')}
              </Button>
            </div>
          </div>
        ) : null}

        {subs === null || (loading && subs.length === 0) ? (
          <p className="muted">{t('common.loading')}</p>
        ) : (
          <HistoryList
            items={filtered}
            data-testid="sub-history"
            // The chips narrow outside this component, so it has to be told, or a
            // filter change leaves the reader on page four of a two-page list.
            resetKey={statusFilter}
            // Search first, then narrow: the chips sit under the search line, in
            // the same place every list that has them puts theirs.
            filters={
              <div className="sub-chips" data-testid="sub-filters">
                {(['all', 'active', 'completed', 'cancelled', 'expired'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`sub-chip ${statusFilter === s ? 'sub-chip--on' : ''}`}
                    onClick={() => {
                      setStatusFilter(s);
                    }}
                    data-testid={`sub-chip-${s}`}
                  >
                    {t(`sub.filter.${s}` as never)} <span className="sub-chip__n">{counts[s]}</span>
                  </button>
                ))}
              </div>
            }
            searchText={subHaystack}
            // Sort is this screen's own: a subscription is a live thing, so "ends
            // soonest" and "biggest budget" are questions a list of past events
            // never has. It belongs in the same row as search and date, not in a
            // bare `select` beside them, which is what it used to be.
            control={{
              value: sort,
              ariaLabel: t('sub.sortAria'),
              onChange: (v) => setSort(v as SortKey),
              options: [
                { value: 'newest', label: t('sub.sort.newest') },
                { value: 'oldest', label: t('sub.sort.oldest') },
                { value: 'amountHigh', label: t('sub.sort.amountHigh') },
                { value: 'amountLow', label: t('sub.sort.amountLow') },
                { value: 'endsSoon', label: t('sub.sort.endsSoon') },
              ],
            }}
            // A subscription's date is when it runs out, which is ahead of now, so
            // the same control has to narrow forwards. Grouped under the day it
            // ends, filtered by how soon that is.
            timestamp={(s) => s.expiry * 1000}
            dateDirection="future"
            rowKey={(s) => s.account}
            searchPlaceholder={t('sub.searchPh')}
            emptyText={t('sub.empty')}
            noMatchText={t('sub.noMatch')}
            pageSize={PAGE_SIZE}
            renderRow={(s) => {
              const name = displayLabel(s.account, s.announcedLabel);
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
                      ? t('sub.nextPullAt', {
                          when: new Date(s.nextPullAt * 1000).toLocaleTimeString(),
                        })
                      : s.balance === 0n
                        ? t('sub.notFundedYet')
                        : t('sub.budgetSpent');
              return (
                <HistoryRow key={s.account} data-testid="sub-item">
                  <HistoryRow.Head
                    lead={
                      <>
                        <span className="sub-row__name">{name || short(s.target)}</span>
                        <span
                          className="sub-badge"
                          style={{
                            color: STATUS_COLOR[s.status],
                            borderColor: STATUS_COLOR[s.status],
                          }}
                        >
                          {t(`sub.filter.${s.status}` as never)}
                        </span>
                      </>
                    }
                    // Lowercased: the label is written for a dropdown, and "0.01
                    // Every minute" mid-line reads as two sentences colliding.
                    // Locale-aware because Turkish lowercases I to a dotless one.
                    amount={`${formatUnits(s.perPull, 6)} ${t(
                      `sub.freq.${frequencyKeyOf(s.interval)}` as never,
                    ).toLocaleLowerCase()}`}
                  />
                  {/* The two addresses were only ever shown shortened inside the
                      detail panel, so paying the same merchant again meant opening a
                      drawer to read something you could not copy. */}
                  <HistoryRow.Facts>
                    <HistoryRow.Fact label={t('sub.d.merchant')}>
                      <AddressChip address={s.target} />
                    </HistoryRow.Fact>
                    <HistoryRow.Fact label={t('sub.d.account')}>
                      <AddressChip address={s.account} />
                    </HistoryRow.Fact>
                    <HistoryRow.Fact label={t('sub.remaining')}>
                      <span className="mono">
                        {formatUnits(s.remaining, 6)}/{formatUnits(s.cap, 6)} USDC
                      </span>
                      <span className="sub-bar">
                        <span style={{ width: `${pct}%` }} />
                      </span>
                    </HistoryRow.Fact>
                  </HistoryRow.Facts>
                  <HistoryRow.Actions>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpenDetail(open ? null : s.account)}
                      data-testid="sub-detail-toggle"
                    >
                      {t('sub.details')}
                    </Button>
                    {s.status === 'active' && (
                      <>
                        <Button
                          size="sm"
                          title={pullHint}
                          disabled={locked || s.pullableNow === 0n}
                          loading={mine && busy?.action === 'pull'}
                          onClick={() => void guard(() => pullNow(s))}
                          data-testid="sub-pull"
                        >
                          {/* While the charge is in flight the label stays on the
                              action. `pullableNow` drops to zero the instant the pull
                              lands, so reading it here put a spinner on a button that
                              already said "Not yet". */}
                          {mine && busy?.action === 'pull'
                            ? t('sub.pulling')
                            : s.pullableNow > 0n
                              ? t('sub.pullNow')
                              : t('sub.tooSoon')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={locked}
                          loading={mine && busy?.action === 'cancel'}
                          onClick={() => void guard(() => cancel(s))}
                          data-testid="sub-cancel"
                        >
                          {t('sub.cancel')}
                        </Button>
                      </>
                    )}
                  </HistoryRow.Actions>
                  {open && (
                    <SubDetail
                      sub={s}
                      // Seed the box with the override if there is one, so an empty
                      // field means "no override" rather than "erase the announced
                      // name". Clearing it falls back to what the chain says.
                      name={localLabel(s.account)}
                      onLabel={(v) => {
                        setLabel(s.account, v);
                        void reload();
                      }}
                    />
                  )}
                </HistoryRow>
              );
            }}
          />
        )}
      </Card>
    </>
  );
}

/**
 * The row's cadence, in the same words the form offers.
 *
 * A box created before this screen spoke in frequencies can carry any interval, so
 * an exact match is not guaranteed; the nearest named one reads far better than a
 * raw seconds count and is never off by more than the gap between two of them.
 */
function frequencyKeyOf(secs: number): FrequencyKey {
  let best: FrequencyKey = FREQUENCIES[0].key;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const f of FREQUENCIES) {
    const gap = Math.abs(f.secs - secs);
    if (gap < bestGap) {
      bestGap = gap;
      best = f.key;
    }
  }
  return best;
}

/** `0.02` not `0.0200000`, and `12` not `12.0`. The summary is read, not parsed. */
function trimAmount(n: number): string {
  return Number(n.toFixed(6)).toString();
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
        {/* The same short-and-copyable address the rows use. These two were the
            only addresses in the app printed in full with no way to copy them,
            which is backwards: a 42-character string is unreadable and the one
            thing you actually want from it is the clipboard. */}
        <div>
          <dt>{t('sub.d.account')}</dt>
          <dd>
            <AddressChip address={sub.account} />
          </dd>
        </div>
        <div>
          <dt>{t('sub.d.merchant')}</dt>
          <dd>
            <AddressChip address={sub.target} />
          </dd>
        </div>
        <div>
          <dt>{t('sub.d.perPull')}</dt>
          <dd>{formatUnits(sub.perPull, 6)} USDC</dd>
        </div>
        <div>
          <dt>{t('sub.d.cap')}</dt>
          <dd>{formatUnits(sub.cap, 6)} USDC</dd>
        </div>
        <div>
          <dt>{t('sub.d.spent')}</dt>
          <dd>{formatUnits(sub.spent, 6)} USDC</dd>
        </div>
        <div>
          <dt>{t('sub.d.remaining')}</dt>
          <dd>{formatUnits(sub.remaining, 6)} USDC</dd>
        </div>
        <div>
          <dt>{t('sub.d.balance')}</dt>
          <dd>{formatUnits(sub.balance, 6)} USDC</dd>
        </div>
        <div>
          <dt>{t('sub.d.lastPull')}</dt>
          <dd>{sub.lastPull === 0 ? t('sub.d.never') : fmtTime(sub.lastPull)}</dd>
        </div>
        <div>
          <dt>{t('sub.d.nextPull')}</dt>
          <dd>
            {sub.status !== 'active'
              ? '—'
              : nextIn === 0
                ? t('sub.d.now')
                : fmtTime(sub.nextPullAt)}
          </dd>
        </div>
        <div>
          <dt>{t('sub.d.expiry')}</dt>
          <dd>{fmtTime(sub.expiry)}</dd>
        </div>
      </dl>
      {/* Renaming and "open this on a block explorer" were one row of three
          controls, which read as three steps of the same action and was none of
          them. Renaming is an edit and gets a labelled field that says what it
          changes and what it does not; the link is not an edit and sits apart. */}
      <div className="sub-rename">
        <Field label={t('sub.rename')} hint={t('sub.renameHint')}>
          <div className="row" style={{ gap: 8 }}>
            <Input
              className="grow"
              value={edit}
              onChange={(e) => setEdit(e.target.value)}
              placeholder={name || t('sub.labelPh')}
              data-testid="sub-label-edit"
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={edit.trim() === name.trim()}
              onClick={() => onLabel(edit)}
              data-testid="sub-label-save"
            >
              {t('sub.renameSave')}
            </Button>
          </div>
        </Field>
        {/* Only offered when there is an override to drop. Without it the way back
            to the announced name is "clear the box and press a button labelled
            Rename", which is not something anyone would guess. */}
        {name.trim() !== '' && (
          <button
            type="button"
            className="sub-rename__clear"
            onClick={() => {
              setEdit('');
              onLabel('');
            }}
            data-testid="sub-label-clear"
          >
            {t('sub.renameClear')}
          </button>
        )}
      </div>

      <div className="sub-detail__link">
        <a className="row" href={explorerAddressUrl(sub.account)} target="_blank" rel="noreferrer">
          {t('common.viewOnArcScan')} <IconExternal width={13} height={13} />
        </a>
      </div>
    </div>
  );
}
