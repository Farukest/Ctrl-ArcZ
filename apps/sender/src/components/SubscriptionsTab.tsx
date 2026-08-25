import { useEffect, useMemo, useState } from 'react';
import {
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
  ARC_TESTNET_CHAIN_ID,
  cctpChainByChainId,
  deploymentFor,
  isGatewayChain,
  SIGNING_RPC_URLS,
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
  usdc as fmtUsdc,
  chainLabel,
  assertBoxFundable,
  fundBoxFromGateway,
  awaitBoxFunded,
  quoteGatewaySpend,
  maxDepositable,
  depositToGateway,
  GATEWAY_CHAIN_NAMES,
  DEPOSIT_CONFIRMATION_SECONDS,
  CCTP_CHAINS,
  type GatewayChain,
} from '@ctrl-arcz/sdk';
import {
  bridgeClients,
  getPublicClient,
  supportsChain,
  switchWalletTo,
  useWalletChain,
  type Session,
} from '@ctrl-arcz/demo-kit';
import { getStealthKeys } from '../lib/stealthKeys.js';
import { relayCreateBox, relayStealthGas } from '../lib/relay.js';
import {
  AmountField,
  Button,
  Card,
  ChainLogo,
  MerchantLogo,
  MERCHANTS,
  CostBlock,
  GatewayFundBox,
  HistoryList,
  ListSkeleton,
  HistoryRow,
  type RowTone,
  Address as AddressChip,
  Field,
  Input,
  NeedsChain,
  Select,
  Skeleton,
  Stepper,
  IconExternal,
  useSubmitGuard,
  useT,
  useToast,
  short,
  parseAmount,
  ActivityBlock,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { useSubscriptions, type Subscription, type SubStatus } from '../lib/useSubscriptions.js';
import { useRecipientGate } from '../lib/useRecipientGate.js';
import { RiskGate } from './RiskGate.js';
import { displayLabel, localLabel, setLabel } from '../lib/subscriptionLabels.js';
import { startRun, useActivity, type RunHandle } from '../lib/activity.js';
import { activityLabels, toActivityItem } from '../lib/activityView.js';
import { pendingOn, rememberDeposit } from '../lib/pendingDeposits.js';
import { useGatewayBalances, useWalletUsdc } from '../lib/balances.js';

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

/**
 * The escape hatch in the merchant list, as a value no merchant can collide with.
 * A sentinel rather than an empty string, because empty is what "nothing chosen yet"
 * already means and the two have to stay different.
 *
 * Written as an escape rather than a literal NUL byte: the same string at run
 * time, but a raw NUL makes every text tool treat this file as binary, and a
 * grep that silently skips a file is worse than no grep.
 */
const MERCHANT_OTHER = '\u0000other';

type SortKey = 'newest' | 'oldest' | 'amountHigh' | 'amountLow' | 'endsSoon';
type CreatePhase = 'idle' | 'machine' | 'creating' | 'funding' | 'listing' | 'done' | 'vetoed';

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as Hex;
}

/**
 * Which tone the shared row status wears.
 *
 * This used to be a bordered uppercase pill of its own, drawn from a colour map
 * and living in the app's stylesheet. It came out louder than the subscription's
 * own name beside it, which is the wrong way round: the name is what the row is,
 * the status is a detail of it. Every other list in this app says the same thing
 * with a small dot and quiet text, so this one does too.
 *
 * Only a live subscription is green. The three ways of being finished read as
 * inert rather than as three different colours, and only an expired box gets a
 * warning, because that is the one where money can still be sitting in it.
 */
const STATUS_TONE: Record<SubStatus, RowTone> = {
  active: 'ok',
  expired: 'warn',
  completed: 'idle',
  cancelled: 'idle',
  empty: 'idle',
};

/** Name, merchant and box address: the three things someone searches a box by. */
function subHaystack(s: Subscription): string {
  // Search matches whichever name is on screen, plus the announced one, so typing
  // a name that a different device set still finds the row.
  return `${displayLabel(s.account, s.announcedLabel)} ${s.announcedLabel} ${s.target} ${s.account}`;
}

export function SubscriptionsTab({
  session,
  onSwitchChain,
}: {
  session: Session;
  onSwitchChain: (chainId: number) => Promise<void>;
}) {
  const t = useT();
  /**
   * Pulling and cancelling need the wallet on the box's chain; creating does not.
   *
   * Creating sends no transaction from this wallet at all: the firewall is an HTTP
   * call, the stealth key and the relay request are message signatures, the relayer
   * submits the deploy, and the budget arrives as a Circle mint out of the Gateway
   * balance -- `spendFromGateway` never asks what chain the wallet is on. Funding
   * from Base while the box lives on Arc is the point of that route, so gating
   * creation on Arc would have refused the one thing Gateway is for.
   *
   * `submitPull` and the cancel sweep do go through `session.clients`, which is
   * pinned to Arc, so those are what this guards.
   */
  const canActOnChain = supportsChain(session.chainId, 'subscriptions');
  const toast = useToast();
  const guard = useSubmitGuard();
  const { subs, loading, reload, track, stealthLocked, unlockStealth } = useSubscriptions(session);

  // Create form
  const [label, setLbl] = useState('');
  /** The list was declined, so the name is being typed. */
  const [namingByHand, setNamingByHand] = useState(false);
  const [target, setTarget] = useState('');
  const [perPull, setPerPull] = useState('0.02');
  const [frequency, setFrequency] = useState<FrequencyKey>('minute');
  const [charges, setCharges] = useState('5');
  const [phase, setPhase] = useState<CreatePhase>('idle');
  const [gwCeiling, setGwCeiling] = useState<bigint | null>(null);
  /**
   * Whether Circle answered at all.
   *
   * The read used to fail silently on the reasoning that keeping the last figures
   * beats blanking the form. True on the second poll; on the first there are no
   * last figures, so a persistent failure left the fee and the total null forever
   * with nothing on screen saying why. That was survivable while a null row simply
   * did not render. It stopped being survivable when the row became a placeholder,
   * because a shimmer is a promise, and this one was never going to be kept.
   */
  const [gwState, setGwState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  /** Bumped to ask for the figures again after a failure. */
  const [gwRetry, setGwRetry] = useState(0);
  /**
   * What this browser has deposited on the chosen chain that Circle has not yet
   * credited.
   *
   * This was `useState(0n)` with no setter: a value that could never be anything
   * but zero, passed to a component whose whole job with it is to say "several
   * USDC are on their way". So the note it drives had never once appeared here,
   * and a deposit made on this screen was followed by a balance that did not move
   * and a screen that did not explain why. The bridge screen has always tracked
   * this properly; there is one mechanism and this is now wired to it.
   */
  const [gwPending, setGwPending] = useState<bigint>(0n);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositing, setDepositing] = useState(false);
  /**
   * Everything this browser has moved, live.
   *
   * There is no separate piece of state for the deposit in progress. It is a
   * record from its first moment like everything else, so a second deposit is a
   * second row rather than something that has to wait for the first to clear, and
   * a reload picks it up where it was.
   */
  const activity = useActivity();
  /** The run this screen has just started, for the block below to point at once. */
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [veto, setVeto] = useState<string | null>(null);

  /**
   * Which chain's Gateway balance pays for the box, and where the wallet stands.
   *
   * Not "the balance": Circle reads one figure across chains but spends it per
   * chain, and an intent carries a single source domain. Deciding on the total is
   * how a form lets someone create a subscription against money the intent cannot
   * reach, which Circle then refuses after it has been signed.
   *
   * It opened on Arc no matter where the wallet was, so a wallet on Ethereum
   * Sepolia was shown Arc's Gateway balance, an empty wallet figure beside it, and
   * a note explaining that its own money could not be read from here. All three
   * were consequences of a default that had ignored the header chip. The binding
   * starts from the wallet's chain instead, and picking another one here moves the
   * wallet, because the deposit is a transaction on the chain being funded.
   *
   * Creating the subscription is unaffected by any of that: the box is deployed by
   * the relayer and funded by Circle, so it is signatures all the way down and
   * works from whichever network the user is on.
   */
  const gw = useWalletChain<GatewayChain>({
    options: GATEWAY_CHAIN_NAMES,
    chainIdOf: (name) => CCTP_CHAINS[name].chainId,
    walletChainId: session.chainId,
    fallback: 'Arc_Testnet',
    switchWallet: (chainId, name) =>
      switchWalletTo(chainId, chainLabel(name)).catch((e: unknown) => {
        toast.fail(e);
      }),
    onChange: () => forgetGwReads(),
  });
  const gwSource = gw.value;

  /*
   * Gateway and wallet balances come from the shared store, so this tab shows the
   * last-known figures at once on re-entry and refreshes behind them instead of
   * blanking and re-reading each visit. `gwOnSource` null is "not read yet"
   * (loading); `gwBalanceFailed` is "Circle answered with nothing"; `walletOnGwChain`
   * null is loading or "the wallet is on another network".
   */
  const gatewayBal = useGatewayBalances(session.address as Address);
  const walletBal = useWalletUsdc(gwSource, session.chainId, session.address as Address);
  const gwOnSource = gwSource && gatewayBal.value ? (gatewayBal.value[gwSource] ?? 0n) : null;
  const gwBalanceFailed = gatewayBal.resolved && !gatewayBal.value;
  const walletOnGwChain = walletBal.value ?? null;

  /**
   * The chain the box lives on, which is the chain the wallet is on, because that
   * is where the relayer deploys it.
   *
   * Everything after the deploy used to name Arc outright: the policy's token, the
   * fundable check, the Gateway destination and the wait for the money. That was
   * true when a box could only exist on Arc. It stopped being true when boxes
   * started being deployed on Base, Ethereum and Arbitrum Sepolia, and what it left
   * behind was a subscription whose box is on one chain and whose funding names
   * another. Derived once here so the four of them cannot drift apart again.
   *
   * `boxUsdc` comes from the box's own deployment rather than Arc's address book:
   * `0x3600...` is USDC on Arc and nothing at all anywhere else, and it was going
   * into the policy the box enforces.
   */
  const boxChain = cctpChainByChainId(session.chainId);
  const boxUsdc = deploymentFor(session.chainId)?.usdc as Address | undefined;
  /** The same chain as a Gateway destination, when Circle can mint there at all. */
  const boxGatewayChain =
    boxChain && isGatewayChain(boxChain) ? (boxChain as GatewayChain) : undefined;
  /**
   * A client that can answer for the box's chain.
   *
   * Arc has its own RPCs and is readable from anywhere; every other chain is only
   * reachable through the wallet's provider, which answers for the network the
   * wallet is on. That is the same network the box is on, so this can always be
   * read, and reading it through Arc's client is what made a deployed box look
   * absent.
   */
  const boxClient = () =>
    session.chainId === ARC_TESTNET_CHAIN_ID
      ? getPublicClient()
      : bridgeClients(session.chainId, session.address as Address).publicClient;

  /** Everything read for the old chain describes the old chain, whether it changed
   *  in the picker or in MetaMask. */
  function forgetGwReads() {
    // The balances are derived from the shared store, keyed by chain, so they
    // follow the source change on their own; only the fee, its state and the
    // deposit field reset here.
    setGwCeiling(null);
    setDepositAmount('');
    // A new chain is a new read, not a continuation of the failed one.
    setGwState('loading');
  }

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
  // `canActOnChain` joins this because a pull and a cancel are transactions from
  // this wallet on the box's chain, and a button that submits to the wrong network
  // is a button that fails after the click rather than before it.
  const locked = busy !== null || creating || !canActOnChain;
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
   * The budget in subunits, derived once.
   *
   * Charge times count, at the contract's six decimals. It used to be computed
   * inside create, where the form could not see it -- and the form now has to know
   * it to answer whether the Gateway balance covers it. Computing it in floats and
   * formatting back would round a budget the user never chose.
   */
  const perPullAmt = parseAmount(perPull) ?? 0n;
  const capAmt = chargeCount > 0 ? perPullAmt * BigInt(chargeCount) : 0n;
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

  /**
   * What a spend of this size would cost, and what is still uncredited.
   *
   * The balance itself is the shared store's job (`gatewayBal`/`walletBal` above);
   * this asks Circle only for the fee, which is per-route and priced to where the
   * money is actually going -- quoting a route to Arc while funding one to Base put
   * a fee on screen that belonged to a different transfer. `gwPending` is what this
   * browser has deposited that Circle has not yet counted, for the note under the
   * box; the crediting itself is `useSettleDeposits`, app-level.
   */
  useEffect(() => {
    if (!gwSource) return;
    let live = true;
    const read = async () => {
      setGwPending(pendingOn(gwSource));
      if (!boxGatewayChain) {
        setGwState((prev) => (prev === 'ready' ? 'ready' : 'unavailable'));
        return;
      }
      try {
        const quote = await quoteGatewaySpend({
          from: gwSource,
          to: boxGatewayChain,
          amount: 1_000_000n,
          depositor: session.address as Address,
        });
        if (!live) return;
        setGwCeiling(quote.maxFee);
        setGwState('ready');
      } catch {
        if (!live) return;
        // Stale figures still beat blanking; the first failure is not, because the
        // form cannot price a subscription without a fee.
        setGwState((prev) => (prev === 'ready' ? 'ready' : 'unavailable'));
      }
    };
    void read();
    const timer = setInterval(() => void read(), 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session.address, gwSource, boxGatewayChain, gwRetry]);

  /**
   * Whether this subscription can be paid for out of the chosen chain's balance.
   *
   * The whole budget goes in at once, plus Circle's fee ceiling, and the answer is
   * about that one chain. There is no lowering the amount, no offering another
   * chain and no falling back to a wallet transfer: the wallet transfer is the
   * thing this change removed, and a second route would be a second way to leave
   * that line on chain.
   */
  const gwNeeded = gwCeiling == null ? null : capAmt + gwCeiling;
  const gwShort = gwOnSource != null && gwNeeded != null && capAmt > 0n && gwOnSource < gwNeeded;
  const gwMissing = gwShort && gwOnSource != null && gwNeeded != null ? gwNeeded - gwOnSource : 0n;
  const gwChainOptions = GATEWAY_CHAIN_NAMES.map((id) => ({
    value: id,
    label: chainLabel(id),
    text: chainLabel(id),
    icon: <ChainLogo id={id} size={20} />,
  }));
  const gwWaitSecs = DEPOSIT_CONFIRMATION_SECONDS[gwSource];
  const gwWaitLabel = gwWaitSecs < 60 ? `${gwWaitSecs}s` : `${Math.round(gwWaitSecs / 60)}m`;

  /**
   * Move wallet USDC into the Gateway balance, switching the wallet's network first
   * if it is elsewhere. Being on the wrong chain is a step, not a refusal.
   */
  async function depositToGw() {
    const n = Number(depositAmount);
    const amount = Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
    if (amount <= 0n) return;
    const chain = CCTP_CHAINS[gwSource];
    if (session.chainId !== chain.chainId) {
      setSwitching(true);
      try {
        await switchWalletTo(chain.chainId, chainLabel(gwSource));
      } catch (e) {
        toast.fail(e);
        return;
      } finally {
        setSwitching(false);
      }
    }
    setDepositing(true);
    const on = gwSource;
    const amountText = depositAmount;
    /*
     * The record opens before the wallet prompt does.
     *
     * That is the moment it matters most: MetaMask is in front of the page, the
     * page itself is saying nothing, and if the tab is closed there the money may
     * still have moved. A row that exists from the start is a row that can say so
     * afterwards. It is also why nothing here holds a slot on screen -- two
     * deposits are two rows, and neither waits for the other.
     */
    const run = startRun({
      kind: 'deposit',
      engine: 'gateway',
      from: on,
      to: on,
      amount: amountText,
    });
    setSpotlight(run.id);
    run.begin('approve');
    let reached = 'approve';
    try {
      await depositToGateway(bridgeClients(chain.chainId, session.address as Address), {
        chain: on,
        amount,
        onStep: (step, txHash) => {
          if (step !== 'approve' && step !== 'deposit') return;
          // `approve` with no hash is the SDK saying the allowance already covered
          // this: a step that did not need to happen rather than one that did, and
          // it is drawn as a dash instead of a tick.
          if (step === 'approve' && !txHash) run.skip('approve');
          else run.done(step, txHash);
          if (step === 'approve') {
            run.begin('deposit');
            reached = 'deposit';
          }
        },
      });
      /*
       * The transaction is mined and the money still cannot be spent. Circle credits
       * it after the source chain's own confirmations, which is seconds on Arc and
       * was measured at over twenty minutes on Base, and that wait is the last step
       * rather than the end of the run. Saying so is what moves the spinner off the
       * deposit, which is genuinely finished, and onto the thing that is not.
       */
      run.begin('counted');
      run.waiting();
      rememberDeposit(on, amount);
      setGwPending(pendingOn(on));
      setDepositAmount('');
      toast.push(t('bridge.deposited', { amount: fmtUsdc(amount), wait: gwWaitLabel }), 'success');
    } catch (e) {
      // Both are told which prompt it was: a deposit asks for an approval and
      // then for the deposit itself.
      run.fail(reached, e);
      toast.fail(e, { step: `bridge.rowstep.${reached}` });
    } finally {
      setDepositing(false);
    }
  }

  /** A deposit pays its own gas where gas is USDC, so the whole balance is never it. */
  const maxDeposit =
    walletOnGwChain == null
      ? null
      : maxDepositable(
          walletOnGwChain,
          (CCTP_CHAINS[gwSource] as { gasToken?: string }).gasToken === 'usdc' ? 10_000n : 0n,
        );

  const canCreate =
    validTarget &&
    perPullNum > 0 &&
    countError === null &&
    gate.armed &&
    // The chosen chain's Gateway balance covers the whole budget and the fee, or
    // this cannot be created. Not a warning next to a live button.
    //
    // The fee is named here rather than left to `gwShort`, which is false while
    // the fee is unknown and would let the button go live on a price nobody has
    // read. That used to hold only because both figures arrived together or not
    // at all; they are read separately now, so the requirement has to be said.
    !gwShort &&
    gwOnSource != null &&
    gwCeiling != null &&
    (phase === 'idle' || phase === 'done' || phase === 'vetoed');

  const createSteps: Step[] = useMemo(() => {
    const order: CreatePhase[] = ['machine', 'creating', 'listing', 'funding'];
    const labels = [
      t('sub.step.machine'),
      t('sub.step.create'),
      t('sub.step.listing'),
      // Named for what is actually happening. "Funding budget" described a
      // transaction that finished when it was mined; this one is Circle minting,
      // and it is answered by the box's balance rather than by a receipt.
      t('sub.step.fundGw'),
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

  const activityItems = useMemo(
    () => activity.map((b) => toActivityItem(b, t as never)),
    [activity, t],
  );

  async function create() {
    setVeto(null);
    const clients = session.clients;
    const owner = session.address as Address;
    const to = target as Address;
    /*
     * Opening a subscription is written down like any other movement of money.
     *
     * It is four steps, three of them signatures or waits, and the last of them is
     * Circle minting the budget into the box -- the same wait a deposit has, on the
     * same balance. Leaving it out of the list meant the list could show the money
     * arriving in the balance and then say nothing at all about it leaving.
     *
     * `run` is declared out here so the failure path can name the step that died.
     */
    let run: RunHandle | null = null;
    let at = 'machine';
    const step = (name: string) => {
      at = name;
      run?.begin(name);
    };
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
      run = startRun({
        kind: 'subscription',
        engine: 'gateway',
        from: gwSource,
        to: boxGatewayChain ?? gwSource,
        amount: formatUnits(capAmt, 6),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setSpotlight(run.id);
      step('machine');
      const pre = await cosigner.precheck({ owner, target: to, amount: perPullAmt });
      if (!pre.approved) {
        setVeto(pre.reason);
        setPhase('vetoed');
        // A refusal is an outcome, not a crash. The row says which step said no and
        // why, which is the same reason the banner above gives.
        run.fail('machine', pre.reason);
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
      step('create');
      // The box enforces this policy on its own chain, so the token named in it has
      // to be that chain's USDC. It was Arc's, everywhere.
      if (!boxUsdc || !boxGatewayChain) {
        throw new Error('This network cannot fund a subscription box.');
      }
      const policy = {
        token: boxUsdc,
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

      // 4. Written down before the money moves.
      //
      //    The box address came back from the factory and the ephemeral key is in
      //    hand, so there is nothing here to rediscover. It used to be recorded
      //    after funding, which was harmless while funding was one mined
      //    transaction and is not now: Circle mints minutes later, and a tab closed
      //    during that wait would leave the browser with no note of a box it had
      //    just paid for -- and on this route there is no transfer from the wallet
      //    to find it by either.
      setStatusFilter('active');
      setSort('newest');
      setPhase('listing');
      step('listing');
      await track(account, stealth.ephemeralPubKey, label.trim());

      // 5. Check the box before signing, not while paying.
      //
      //    `fundEphemeral` used to read the deployed policy back and refuse to pay a
      //    box whose target, co-signer, vault, caps, interval, expiry or mode was not
      //    the one we asked for, which is the difference between trusting the relayer
      //    and verifying it. That check has to happen earlier now: a wallet transfer
      //    that fails it is simply never sent, but a Gateway intent cannot be
      //    recalled once Circle has accepted it, so by the time a payment could fail
      //    the money is already committed.
      setPhase('funding');
      step('fundGw');
      await assertBoxFundable(boxClient(), account, policy);

      // 6. Circle mints into the box out of the payer's Gateway balance.
      //
      //    The wallet used to pay the box directly, and that transfer was the one
      //    thing on chain that undid the stealth address the box had been given:
      //    both ends of an ERC-20 transfer are indexed, so anyone could intersect a
      //    wallet's outgoing transfers with the announcer's metadata and recover its
      //    boxes with no viewing key. Measured on a real wallet, eight out of eight.
      //    What Arc sees now is a mint from Circle's minter to the box.
      //
      //    There is no fallback to the wallet transfer. A second route would be a
      //    second way to leave that line on chain, and it is the one that gets taken
      //    when something else has already gone wrong.
      await fundBoxFromGateway(clients, {
        account,
        amount: capAmt,
        from: gwSource,
        to: boxGatewayChain,
      });

      // 7. Funded is when the money is in the box, not when the intent was signed.
      //
      //    Those are seconds to minutes apart on this route. A wait that runs out is
      //    "on its way", never "failed": the transfer is Circle's to finish and the
      //    box will hold the money without this tab being open.
      const landed = await awaitBoxFunded(boxClient(), account, capAmt, boxUsdc);

      setPhase('done');
      // Landed means the money is in the box. Not landed is not a failure: the
      // transfer is Circle's to finish and the box will hold it whether or not
      // this tab is open, so the row waits rather than claiming either outcome.
      if (landed) run.finish();
      else run.waiting();
      toast.push(t(landed ? 'sub.createdToast' : 'sub.fundingOnWay'), landed ? 'success' : 'info');
      setLbl('');
      setTarget('');
      // The slow scans, after the user already has what they asked for.
      void reload(account);
    } catch (e) {
      setPhase('idle');
      run?.fail(at, e);
      toast.fail(e, { step: `sub.step.${at}` });
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
      toast.fail(e);
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

        /**
         * The signing order, not the reading one.
         *
         * This client prepares a transaction, so viem asks `eth_fillTransaction`
         * to find out what the fee is paid in, and two of the four public
         * endpoints refuse that method: drpc answers -32601 and blockdaemon
         * returns 403 "Request method filtered". `RPC_URLS` is ranked for reads
         * and leads with exactly those two, so every sweep paid two doomed round
         * trips and printed a 400 and a 403 that read like a broken app.
         * `SIGNING_RPC_URLS` is the same list ordered for a client that signs.
         */
        const stealthWallet = createWalletClient({
          account: stealthAccount,
          chain: arcTestnet,
          transport: fallback(SIGNING_RPC_URLS.map((u) => http(u))),
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
      toast.fail(e);
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
    const c = {
      all: subs?.length ?? 0,
      active: 0,
      completed: 0,
      cancelled: 0,
      expired: 0,
      empty: 0,
    };
    for (const s of subs ?? []) c[s.status]++;
    return c;
  }, [subs]);

  return (
    <>
      {/*
        FUNDING. Its own block, above the form, in its own colour.

        It used to sit in the middle of the subscription form, between the merchant
        and the amount, which put the one control that spends money from the wallet
        inside a form that spends from somewhere else. They are two different acts:
        this one moves USDC into the balance and is the same balance whatever is
        created next, while everything below is about one subscription. Read as one
        card they looked like one flow with a step in the middle.

        `card--fund` is the accent. A border rather than a heading, because the
        point is that it is a different thing, not that it is a more important one.
      */}
      {canActOnChain && (
        <Card title={t('sub.fundTitle')} className="card--fund" data-testid="sub-fund">
          <GatewayFundBox
            chain={gwSource}
            chainOptions={gwChainOptions}
            onChainChange={(v) => gw.select(v as GatewayChain)}
            balance={gwOnSource}
            balanceMissing={gwBalanceFailed ? 'unavailable' : 'loading'}
            maxDeposit={maxDeposit}
            amount={depositAmount}
            onAmountChange={setDepositAmount}
            walletOnChain={gw.walletHere}
            pending={gwPending}
            wait={t('bridge.gwDepositWait', {
              chain: chainLabel(gwSource),
              wait: gwWaitLabel,
            })}
            format={fmtUsdc}
            busy={depositing || switching || gw.switching}
            onDeposit={() => void guard(depositToGw)}
          />
          {/*
            Short, and that is the end of it.

            No lowered amount, no other chain, no falling back to paying the box
            from the wallet. That transfer is the line on chain this whole change
            exists to remove, and a fallback is the route that gets taken exactly
            when something has already gone wrong.

            It lives with the balance rather than with the form it blocks, because
            what it asks for is a deposit and the deposit is here.
          */}
          {gwShort && (
            <p className="gwfund__err" data-testid="sub-gw-short">
              {t('sub.gwShort', {
                amount: fmtUsdc(gwMissing),
                chain: chainLabel(gwSource),
              })}
            </p>
          )}
        </Card>
      )}

      {/* CREATE */}
      <Card title={t('sub.createTitle')} data-testid="sub-create">
        {/* The form is the action, so the chain question belongs in front of it and
            not beside the list. It used to be answered only down there, which left a
            complete, fillable subscription form on a network that cannot create one:
            merchant, amount, interval, a priced Circle fee and an enabled button,
            and the refusal arrived after a signature. `NeedsChain` exists to spend
            nobody's attention before telling them. */}
        {!canActOnChain ? (
          <NeedsChain feature="subscriptions" onSwitch={onSwitchChain} chainId={session.chainId} />
        ) : (
          <div className="formstack">
            <div className="sub-grid">
              {/*
              Picked, not typed.

              This field was a free text box that people filled in with "Netflix",
              and a name somebody types is a name somebody mistypes: the announced
              label is what every other device reads the subscription by, so a
              typo follows the box everywhere. The list is the same one the Android
              client offers, in the same order, drawn with the same real marks the
              chain picker uses for networks.

              `Something else` is not decoration. A closed list would be a wallet
              telling somebody they may only subscribe to companies it has heard of.
            */}
              <Field label={t('sub.label')}>
                {namingByHand ? (
                  <div className="row" style={{ gap: 8 }}>
                    <Input
                      className="grow"
                      value={label}
                      onChange={(e) => setLbl(e.target.value)}
                      placeholder={t('sub.labelPh')}
                      data-testid="sub-label"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setNamingByHand(false);
                        setLbl('');
                      }}
                      data-testid="sub-merchant-back"
                    >
                      {t('sub.merchantList')}
                    </Button>
                  </div>
                ) : (
                  <Select
                    value={label}
                    options={[
                      ...MERCHANTS.map((m) => ({
                        value: m.name,
                        label: m.name,
                        icon: <MerchantLogo name={m.name} size={20} />,
                      })),
                      { value: MERCHANT_OTHER, label: t('sub.merchantOther') },
                    ]}
                    onChange={(v) => {
                      if (v === MERCHANT_OTHER) {
                        setNamingByHand(true);
                        setLbl('');
                      } else {
                        setLbl(v);
                      }
                    }}
                    ariaLabel={t('sub.pickMerchant')}
                    placeholder={t('sub.pickMerchant')}
                    searchable
                    searchPlaceholder={t('common.search')}
                    noResultsText={t('common.noResults')}
                    full
                  />
                )}
              </Field>
              {/* The accent belongs here rather than on the name: this is the field
                the firewall judges and the one a subscription cannot be wrong
                about. */}
              <Field
                label={t('sub.merchant')}
                accent
                error={target.length > 0 && !validTarget ? t('send.invalidAddress') : null}
              >
                <Input
                  mono
                  value={target}
                  onChange={(e) => setTarget(e.target.value.trim())}
                  onClear={() => setTarget('')}
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

            {/*
            The amount gets the whole row.

            It was sharing one with the frequency picker, which gave a figure, a
            balance, a token pill and a dollar line half the width of the form
            while a dropdown sat in the other half. Three lines squeezed beside
            one is not a pair of equals, and the amount is the number this form is
            actually about.
          */}
            {/* Boxed, because the Gateway funding module sits directly above it and
              a bordered block followed by a bare one reads as unfinished rather
              than as two separate things. */}
            {/*
            No balance beside it, and that is a correction rather than a removal.

            The figure here was the wallet's own USDC on Arc, which does not pay
            for a subscription: the box is funded by Circle out of the Gateway
            balance, and a wallet holding of 173 next to a Gateway balance of zero
            told someone they could afford a subscription the form was about to
            refuse. That balance is stated in the funding box directly above, with
            the control that tops it up, and the shortfall line says what is
            missing. One number, in the place that can act on it.

            It also had to go for a second reason. It followed the wallet's chain
            once the session stopped reading Arc regardless of where the wallet
            was, so off Arc it became a placeholder shimmering for a number that
            was never coming -- a promise this codebase makes only when it can keep
            it.
          */}
            <AmountField
              value={perPull}
              onChange={setPerPull}
              chain="Arc_Testnet"
              label={t('sub.perPull')}
              boxed
              data-testid="sub-perpull"
            />
            {/* The two questions that are actually a pair: how often, and how many. */}
            <div className="sub-grid">
              {/* No note under the minute option. It told the reader that a
                one-minute subscription is for trying the app out, which is a
                sentence about our demo rather than about their money, and it
                pushed the two fields beside it out of line. */}
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
              <Field label={t('sub.count', { unit })} error={countError}>
                <Input
                  value={charges}
                  onChange={(e) => setCharges(e.target.value)}
                  inputMode="numeric"
                  invalid={countError !== null}
                  data-testid="sub-count"
                />
              </Field>
            </div>
            {/*
            What this costs, in the same block the bridge and the send screen use.

            It was a thin grey line reading "Total  0.1 USDC  over 5 min": three
            type sizes on one row, the duration trailing the figure like an
            afterthought, and no mention at all of the fee Circle charges to move
            the money into the box. Creating a subscription is a payment, and it was
            the one payment screen that never said what would leave the wallet.

            The duration is gone rather than restyled. It answered a question the
            end date in the detail panel already answers, and "0.1 USDC over 5 min"
            reads as a rate when it is a budget.
          */}
            {capNum > 0 && chargeCount > 0 && (
              <CostBlock
                testId="sub-summary"
                lines={[
                  {
                    label: t('sub.paymentTotal', {
                      // Locale-aware: Turkish lowercases I to a dotless one.
                      freq: t(`sub.freq.${frequency}` as never).toLocaleLowerCase(),
                    }),
                    value: `${trimAmount(capNum)} USDC`,
                    testId: 'sub-total',
                  },
                  // The box is funded out of the Gateway balance, so Circle's fee is
                  // part of the price of creating one. Still never a zero while the
                  // quote is out, because a zero here would be a claim; but the row
                  // itself is present from the start. Omitting the row entirely grew
                  // this block from 49px to 124px when the quote landed, which pushed
                  // the create button down the screen while it was being aimed at.
                  {
                    label: t('cost.circleFee'),
                    value:
                      gwCeiling == null ? (
                        <Skeleton width={78} height={14} still={gwState === 'unavailable'} />
                      ) : (
                        `${fmtUsdc(gwCeiling)} USDC`
                      ),
                    testId: 'sub-fee',
                  },
                ]}
                total={{
                  label: t('cost.youPay'),
                  // The same figure the funding check refuses against, so the block
                  // and the refusal can never disagree about the price.
                  value:
                    gwNeeded == null ? (
                      <Skeleton width={92} height={16} still={gwState === 'unavailable'} />
                    ) : (
                      `${fmtUsdc(gwNeeded)} USDC`
                    ),
                  testId: 'sub-youpay',
                }}
              />
            )}
            {/* One line and the button that fixes it, rather than two slots waiting
              forever for a number Circle is not going to send. */}
            {gwState === 'unavailable' && (
              <div className="row wrap" data-testid="sub-quote-unavailable">
                <span className="muted grow">{t('sub.quoteUnavailable')}</span>
                <Button variant="ghost" size="sm" onClick={() => setGwRetry((n) => n + 1)}>
                  {t('common.retry')}
                </Button>
              </div>
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
        )}
      </Card>

      {/* LIST */}
      {/* The stealth explanation sits behind the title's `i`. It answers a real
          question -- why a payments app is asking for a signature to show a list --
          but it answers it for the people who ask, and it was four lines above the
          list for everybody. The locked state below is not an explanation, it is
          the one thing standing between the user and their subscriptions, so that
          stays where it cannot be missed. */}
      <Card title={t('sub.listTitle')} data-testid="sub-list">
        {/* No second copy of the chain notice here. It sits in front of the form
            above, which is the thing it stops. It also used to say the list's
            numbers "are true from anywhere", and they are not: a box is read on the
            chain it lives on, so on any other one this list is empty rather than
            informative. */}

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

        {/* The word "Loading" on one line stood in for a 1303px list, so this card
            grew by 1187px in a single frame when the scan finished. It reserves the
            list it is about to be instead. */}
        {subs === null || (loading && subs.length === 0) ? (
          <ListSkeleton rows={PAGE_SIZE} rowHeight={180} chips reserveId="subscriptions" />
        ) : (
          <HistoryList
            items={filtered}
            data-testid="sub-history"
            reserveId="subscriptions"
            // The chips narrow outside this component, so it has to be told, or a
            // filter change leaves the reader on page four of a two-page list.
            resetKey={statusFilter}
            // Search first, then narrow: the chips sit under the search line, in
            // the same place every list that has them puts theirs.
            filters={
              <div className="sub-chips" data-testid="sub-filters">
                {(['all', 'active', 'empty', 'completed', 'cancelled', 'expired'] as const).map(
                  (s) => (
                    <button
                      key={s}
                      type="button"
                      className={`sub-chip ${statusFilter === s ? 'sub-chip--on' : ''}`}
                      onClick={() => {
                        setStatusFilter(s);
                      }}
                      data-testid={`sub-chip-${s}`}
                    >
                      {t(`sub.filter.${s}` as never)}{' '}
                      <span className="sub-chip__n">{counts[s]}</span>
                    </button>
                  ),
                )}
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
              // Fills by what is LEFT, because the number directly above it is what
              // is left. Filling by `spent` under a label reading "Left" made the bar
              // the exact inverse of its own caption: a brand-new subscription showed
              // "Left 0.12/0.12" over an empty track, and an almost-exhausted one
              // showed a nearly full track. Two contradicting truths on one line.
              const pct = s.cap > 0n ? Number((s.remaining * 100n) / s.cap) : 0;
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
                    // The mark the picker chose, carried through to the list. A row
                    // recognised by its logo is the same trick the bridge rows use
                    // for networks, and it is faster to scan than a name in a column
                    // of names.
                    lead={
                      <>
                        <MerchantLogo name={name} size={20} />
                        <span className="sub-row__name">{name || short(s.target)}</span>
                      </>
                    }
                    status={{
                      tone: STATUS_TONE[s.status],
                      label: t(`sub.filter.${s.status}` as never),
                    }}
                    // Lowercased: the label is written for a dropdown, and "0.01
                    // Every minute" mid-line reads as two sentences colliding.
                    // Locale-aware because Turkish lowercases I to a dotless one.
                    amount={`${formatUnits(s.perPull, 6)} ${t(
                      `sub.freq.${frequencyKeyOf(s.interval)}` as never,
                    ).toLocaleLowerCase()}`}
                  />
                  {/* The merchant was only ever shown shortened inside the detail
                      panel, so paying the same merchant again meant opening a drawer
                      to read something you could not copy. The box address is not
                      here for the same reason: it is the subscription's identity and
                      what support and the explorer go by, but nobody copies one out
                      of a list they are scanning for "which, and how much is left".
                      It stays in the detail panel. */}
                  <HistoryRow.Facts>
                    <HistoryRow.Fact label={t('sub.d.merchant')}>
                      <AddressChip address={s.target} />
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

      {/*
        The same block that sits at the bottom of the bridge screen, showing the
        same records. A deposit made here and a deposit made there are the same
        deposit, and the answer to "did that go through" should not depend on which
        screen you were on when you asked.
      */}
      <div style={{ marginTop: 16 }}>
        <ActivityBlock
          items={activityItems}
          labels={activityLabels(t as never, t('activity.fundingTitle'))}
          spotlight={spotlight}
          data-testid="sub-activity"
        />
      </div>
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
