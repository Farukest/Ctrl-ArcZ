import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@ctrl-arcz/demo-kit';
import { erc20Abi, isAddress, parseUnits, type Address } from 'viem';
import {
  bridgeFromWallet,
  chainLabel,
  chainExplorerTxUrl,
  findForwardedMint,
  findGatewayMint,
  gatewayBalance,
  depositToGateway,
  spendFromGateway,
  quoteGatewaySpend,
  isGatewayChain,
  CCTP_CHAINS,
  GATEWAY_CHAIN_NAMES,
  DEPOSIT_CONFIRMATION_SECONDS,
  usdc,
  percentOf,
  maxGatewaySpendable,
  maxDepositable,
  gatewayShortfall,
  isBoxFunding,
  type CctpChainName,
  type CctpStep,
  type GatewayChain,
  type GatewayStep,
} from '@ctrl-arcz/sdk';
import { bridgeClients, getPublicClient, switchWalletChain } from '@ctrl-arcz/demo-kit';
import { activeJobIds, forgetJob, readBridgeJob, type BridgeJob } from '../lib/bridgeJob.js';
import { knownBoxes } from '../lib/useSubscriptions.js';
import {
  BRIDGE_STEPS,
  GATEWAY_STEPS,
  bridgeChainLabel,
  type BridgeChainName,
  type BridgeEngine,
  type BridgeOutcome,
} from '@ctrl-arcz/demo-kit';
import {
  AmountField,
  Button,
  Card,
  ChainLogo,
  Field,
  GatewayFundBox,
  InfoPopover,
  Input,
  SegmentedTabs,
  Select,
  HistoryList,
  HistoryRow,
  Address as AddressChip,
  Copyable,
  short,
  Stepper,
  TxLink,
  useSubmitGuard,
  useT,
  useToast,
  type Step,
  type RowStep,
} from '@ctrl-arcz/demo-kit/ui';
import { loadBridges, saveBridge, type StoredBridge, type StoredBridgeStep } from '../store.js';
import { useRecipientGate } from '../lib/useRecipientGate.js';
import { RiskGate } from './RiskGate.js';
import { pendingOn, reconcile, rememberDeposit } from '../lib/pendingDeposits.js';

// The bridge signs server-side (/api/bridge), so the client never needs the key;
// gate on a non-secret flag instead of inlining a private key just to read a bool.
const bridgeEnabled = import.meta.env.VITE_BRIDGE_ENABLED !== 'false';
const HISTORY_PAGE_SIZE = 5;

/**
 * The SDK names its steps after what CCTP does; the stepper is labelled for what a
 * person sees. They are close but not identical, and mapping here keeps the SDK from
 * carrying this app's vocabulary. `quote` has no row: it is one HTTP call.
 */
const SDK_STEP_TO_UI: Record<CctpStep, string | undefined> = {
  quote: undefined,
  approve: 'approve',
  burn: 'burn',
  attest: 'fetchAttestation',
  forward: 'mint',
};

/** How long a deposit takes to count, as something a person reads rather than a
 *  number of seconds. Shared so the box and the toast never disagree. */
function waitLabel(chain: GatewayChain | undefined): string {
  if (!chain) return '';
  const secs = DEPOSIT_CONFIRMATION_SECONDS[chain];
  return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

const ARC_CHAIN_ID = CCTP_CHAINS.Arc_Testnet.chainId;

/**
 * What a deposit leaves behind for its own gas, on chains that charge it in USDC.
 *
 * Measured rather than guessed: an approve plus a deposit on Arc costs a little
 * under a hundredth of a USDC, and this is that rounded up. Being generous here
 * costs a cent of headroom; being tight produces a Max that reverts, which is the
 * one outcome a Max button must never have.
 */
const DEPOSIT_GAS_RESERVE = 10_000n;

/**
 * USDC the wallet holds on a chain, when it can be read at all.
 *
 * Arc has its own RPC in this app. Every other chain is reachable only through the
 * wallet's own provider, which answers for the network the wallet is currently on:
 * asking it about Base Sepolia while it sits on Arc runs the call against Arc,
 * where that token address is not a token, and answers nothing useful.
 *
 * Null is "cannot be read from here", and the cards show it as a dash. A zero would
 * be a claim about the balance, and this is not one.
 */
async function readUsdcOn(
  chain: CctpChainName,
  connectedChainId: number,
  address: Address,
): Promise<bigint | null> {
  const c = CCTP_CHAINS[chain];
  if (c.chainId !== ARC_CHAIN_ID && connectedChainId !== c.chainId) return null;
  try {
    const client =
      c.chainId === ARC_CHAIN_ID ? getPublicClient() : bridgeClients(c.chainId, address).publicClient;
    return (await client.readContract({
      address: c.usdc as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
  } catch {
    return null;
  }
}

/** Same idea for Gateway, whose four rows are deposit, sign, attestation, mint. */
const GW_STEP_TO_UI: Record<GatewayStep, string | undefined> = {
  approve: 'deposit',
  deposit: 'deposit',
  quote: undefined,
  sign: 'sign',
  transfer: 'attestation',
  mint: 'mint',
};

/**
 * One step row, with an explorer link only when the chain actually has one.
 * `exactOptionalPropertyTypes` means an explicit `undefined` is not the same as an
 * absent field, and the stored record should simply not carry a link it cannot make.
 */
function stepRow(name: string, txHash?: string, chain?: CctpChainName) {
  const url = txHash && chain ? chainExplorerTxUrl(chain, txHash) : undefined;
  return { name, ...(txHash ? { txHash } : {}), ...(url ? { explorerUrl: url } : {}) };
}

/**
 * A stored step as the shared row wants it.
 *
 * Every step is shown, including the ones with no transaction of their own. The
 * previous row rendered a step only when it had both a hash and an https explorer,
 * so the attestation never appeared at all, and on the two chains with no explorer
 * in the registry a completed transfer looked like it had done nothing.
 */
function rowStep(s: StoredBridgeStep, t: (k: 'bridge.rowstep.mint') => string): RowStep {
  // A row is a record, not a progress bar. The live stepper says "Minting on the
  // destination chain"; a finished row only needs the noun.
  return {
    label: t(`bridge.rowstep.${s.name}` as 'bridge.rowstep.mint'),
    ...(s.txHash ? { txHash: s.txHash } : {}),
    ...(s.explorerUrl ? { explorerUrl: s.explorerUrl } : {}),
  };
}

/** Map a server step name to its index in the active engine's step list. */
function stepIndexFor(name: string, list: readonly string[]): number {
  const n = name.toLowerCase();
  const i = list.findIndex((s) => n.includes(s.toLowerCase()));
  if (i >= 0) return i;
  if (n.includes('attest')) return list.findIndex((s) => s.toLowerCase().includes('attest'));
  return -1;
}

function relativeTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Only allow https links to be rendered. Explorer URLs are persisted in
 * localStorage and read back untrusted; a tampered entry could carry a
 * `javascript:`/`data:` URL that would execute in-origin when clicked.
 */
function safeHttpUrl(url?: string): string | undefined {
  return url && /^https:\/\//i.test(url) ? url : undefined;
}

/** Everything a bridge row can be searched by, as one lowercased haystack. */
function bridgeHaystack(b: StoredBridge): string {
  return [
    b.fromLabel,
    b.toLabel,
    b.from,
    b.to,
    `${b.amount} usdc`,
    b.state,
    ...b.steps.map((s) => s.txHash ?? ''),
  ]
    .join(' ')
    .toLowerCase();
}

export function BridgeTab({ session }: { session: Session }) {
  const t = useT();
  const toast = useToast();
  const guard = useSubmitGuard();
  const [engine, setEngine] = useState<BridgeEngine>('cctp');
  const [from, setFrom] = useState<CctpChainName>('Arc_Testnet');
  const [to, setTo] = useState<CctpChainName>('Base_Sepolia');
  /** Set while the wallet is being asked to move to the source chain. */
  const [switching, setSwitching] = useState(false);
  /** Which half of the bridge records the history is showing. */
  const [histKind, setHistKind] = useState<'bridge' | 'subs'>('bridge');
  /**
   * Per chain, because that is what a transfer actually spends. Showing only the
   * total would tell someone with money on Arc that they can send from Base.
   */
  const [gwOnSource, setGwOnSource] = useState<bigint | null>(null);
  /** Every chain that holds something, so a refusal can point at the funded one
   *  instead of asking for a deposit the user does not need to make. */
  const [gwByChain, setGwByChain] = useState<Partial<Record<GatewayChain, bigint>>>({});
  /** Deposited, on chain, but not yet counted by Circle. */
  const [gwPending, setGwPending] = useState<bigint>(0n);
  /**
   * Two figures, deliberately. `gwFee` is what Circle actually charges and is what
   * the user is shown; `gwCeiling` is the padded number that gets signed and is
   * what the balance has to cover. Showing the ceiling would quote a fee nobody
   * pays, and checking against the quote would pass a balance that cannot sign.
   */
  const [gwFee, setGwFee] = useState<bigint | null>(null);
  const [gwCeiling, setGwCeiling] = useState<bigint | null>(null);
  const [depositing, setDepositing] = useState(false);
  /**
   * The deposit's own amount, and the reason this field exists at all.
   *
   * Depositing used to borrow the bridge amount and appear only when that amount
   * exceeded the balance, which broke three ways at once. The primary button
   * changed identity under the user, so pressing it after filling in a transfer
   * deposited instead of bridging and looked, for the twenty minutes a deposit
   * takes to count, exactly like a bridge in progress. It deposited the transfer
   * amount without the fee, so funding an empty balance for a 5 USDC transfer left
   * it short by the fee and offered the same button again. And topping up by any
   * other amount was impossible: with 3 USDC already there, adding 2 meant typing
   * a transfer you did not want. Funding a balance and spending it are two
   * actions, so they get two fields and two buttons.
   */
  const [depositAmount, setDepositAmount] = useState('');
  /** USDC in the wallet on the source chain, so the deposit box can say what
   *  there is to deposit. `null` while unread. */
  const [walletOnChain, setWalletOnChain] = useState<bigint | null>(null);
  /** The same, on the destination, for the card that says what arrives there. */
  const [toBalance, setToBalance] = useState<bigint | null>(null);
  /**
   * Empty means "send it to myself", which is what a bridge normally is. Typing an
   * address here turns the transfer into a payment, and a payment to a hand-typed
   * address is exactly where poisoning lives -- so it goes through the same
   * firewall the send screen uses, not a second, laxer copy of it.
   */
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('0.1');
  const [result, setResult] = useState<BridgeOutcome | null>(null);
  /** Every transfer this browser is following, live from the server. */
  const [jobs, setJobs] = useState<BridgeJob[]>([]);
  /** A CCTP transfer signed by this wallet. It has no server job behind it. */
  const [selfBridge, setSelfBridge] = useState<{
    state: string;
    steps: { name: string; txHash?: string }[];
  } | null>(null);
  /** Jobs already written to history, so polling cannot write them twice. */
  const saved = useRef<Set<string>>(new Set());
  /** The one the stepper describes: the newest still running, else the newest. */
  const job = useMemo(
    () => jobs.find((j) => j.state === 'running') ?? jobs[jobs.length - 1] ?? null,
    [jobs],
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [bridges, setBridges] = useState<StoredBridge[]>(() => loadBridges());
  const [histEngine, setHistEngine] = useState<'all' | BridgeEngine>('all');

  const risk = useRecipientGate(session, recipient);
  const recipientBad = recipient.trim() !== '' && !isAddress(recipient.trim());
  const amountValue = Number(amount);
  const sameChain = from === to;

  /**
   * CCTP burns the connected wallet's own USDC, so the source is whichever chain
   * that wallet is on. That is a prerequisite, not a restriction: every testnet
   * Circle publishes is offered, and picking one the wallet is not on turns the
   * button into the switch it needs rather than greying it out with no explanation.
   */
  const cctpSource = engine === 'cctp' ? CCTP_CHAINS[from as CctpChainName] : undefined;
  const walletOnSource = !cctpSource || session.chainId === cctpSource.chainId;

  /**
   * Gateway's source chain says where the money is deposited, not where the wallet
   * has to be. Spending is a signature and nothing else, so the wallet can sit on
   * any network while it happens. Only a deposit is an on-chain transaction, and
   * only that needs the wallet moved.
   */
  const gwSource =
    engine === 'gateway' && isGatewayChain(from) ? (from as GatewayChain) : undefined;
  const gwNeeded = gwCeiling != null ? BigInt(Math.round(amountValue * 1e6)) + gwCeiling : null;
  const depositNum = Number(depositAmount);
  const depositValue =
    Number.isFinite(depositNum) && depositNum > 0 ? BigInt(Math.round(depositNum * 1e6)) : 0n;
  /**
   * The most that can be moved into Gateway from this chain.
   *
   * On a chain that charges gas in USDC, the whole balance is an amount that
   * cannot pay for its own deposit transaction: filling it in produces a signature
   * and then a revert. What stays behind is a reserve, and only on those chains --
   * elsewhere gas is a separate token and none of this balance is owed to it.
   */
  const maxDeposit =
    walletOnChain == null
      ? null
      : maxDepositable(
          walletOnChain,
          // Only Arc declares a gas token, so the field is absent elsewhere rather
          // than set to something else; read it off a widened view of the entry.
          gwSource && (CCTP_CHAINS[gwSource] as { gasToken?: string }).gasToken === 'usdc'
            ? DEPOSIT_GAS_RESERVE
            : 0n,
        );

  /**
   * The balance a spend actually draws on, which differs by engine.
   *
   * Kept apart on purpose: money in Gateway is spendable with a signature alone,
   * money in the wallet is not, and a screen that showed one as the other would
   * offer transfers the signature cannot cover.
   */
  const spendable = engine === 'gateway' ? gwOnSource : walletOnChain;
  /**
   * The most that balance can send, fee included.
   *
   * On Gateway the fee comes out of the same balance, so the whole balance is the
   * one figure guaranteed to be refused. Null while the fee is unknown, which
   * disables the percentage chips rather than letting them offer that figure.
   */
  const maxSpendable =
    spendable == null
      ? null
      : engine === 'gateway'
        ? gwCeiling == null
          ? null
          : maxGatewaySpendable(spendable, gwCeiling)
        : spendable;

  function fillPercent(fraction: number) {
    if (maxSpendable == null) return;
    setAmount(percentOf(maxSpendable, fraction));
  }

  /**
   * Same chain in and out is not a mistake in Gateway, it is the way money comes
   * back. Calling it a bridge would be wrong, so the button says what it does.
   */
  const gwWithdraw = engine === 'gateway' && sameChain;
  const walletOnDepositChain = !gwSource || session.chainId === CCTP_CHAINS[gwSource].chainId;
  const running = jobs.filter((j) => j.state === 'running').length;
  const canBridge =
    bridgeEnabled &&
    amountValue > 0 &&
    (!sameChain || engine === 'gateway') &&
    !recipientBad &&
    // The whole firewall opinion, including the wait for a verdict that is still
    // forming. This used to be `!risk.blocked` alone, so the button armed while
    // the scan was running and again before the investigator landed: the rules
    // said safe, the transfer left, and the escalation arrived after it.
    risk.armed &&
    // Gateway needs both ends to be chains it serves. Without this the button was
    // clickable in a state where `run` could only return without doing anything.
    (engine !== 'gateway' || (!!gwSource && isGatewayChain(to)));

  // Prefer the demo-kit label where one exists (it carries the brand spelling);
  // fall back to the SDK's, so a newly added chain still reads properly.
  const labelFor = (id: string) =>
    bridgeChainLabel(id) === id ? chainLabel(id as CctpChainName) : bridgeChainLabel(id);
  const fromLabel = labelFor(from);
  const toLabel = labelFor(to);

  const chainOptions = (
    engine === 'gateway'
      ? GATEWAY_CHAIN_NAMES.map((id) => ({ id, label: labelFor(id) }))
      : (Object.keys(CCTP_CHAINS) as CctpChainName[]).map((id) => ({ id, label: labelFor(id) }))
  ).map((c) => ({
    value: c.id,
    label: c.label,
    text: c.label,
    icon: <ChainLogo id={c.id} size={20} />,
  }));

  /** A fee larger than the transfer is not a rounding detail, it is the reason to
   *  pick another route or to send more at once. */
  const feeSteep =
    amountValue > 0 && gwFee != null && gwFee > BigInt(Math.round(amountValue * 1e6));

  /**
   * Why this cannot be sent, worked out while the amount is being typed.
   *
   * Asked here rather than inside submit, because a refusal that arrives after the
   * wallet has been opened has already cost the user something. The rule itself is
   * in the SDK and tested there, so this and the check that runs at burn time
   * cannot drift into disagreeing.
   */
  const refusal =
    engine !== 'gateway' || amountValue <= 0 || gwOnSource == null || gwNeeded == null
      ? null
      : gatewayShortfall({
          here: gwOnSource,
          byChain: gwByChain as Record<string, bigint>,
          from,
          fromLabel,
          committed: gwNeeded,
          labelOf: labelFor,
        });

  /**
   * The button agrees with the refusal above it.
   *
   * Two answers to "can this be sent" is how a disabled button and an encouraging
   * sentence end up on screen together, or worse, an enabled button under a line
   * saying it cannot work.
   */
  const canSend = canBridge && refusal === null;

  /** The refusal names one thing to change; this changes it, so the user is not
   *  sent off to find a picker or to work out an amount. */
  function applyFix() {
    const fix = refusal?.fix;
    if (!fix) return;
    if (fix.kind === 'switchSource') selectSource(fix.chain as CctpChainName);
    else if (fix.kind === 'useMax') setAmount(fix.display);
    else setDepositAmount(fix.display);
  }

  // Gateway supports fewer chains than CCTP; when switching to it, snap any
  // now-unsupported selection back to a valid default so the pickers never show
  // an out-of-list value.
  const changeEngine = (e: BridgeEngine) => {
    setEngine(e);
    if (e === 'gateway') {
      if (!isGatewayChain(from)) setFrom('Arc_Testnet');
      if (!isGatewayChain(to)) setTo('Base_Sepolia');
    }
  };

  /**
   * Read the Gateway balance and what a spend of this size would cost.
   *
   * Both come from Circle and neither needs the wallet, so this runs whenever the
   * tab is on Gateway. The fee turns out to be flat, but it is asked for rather than
   * assumed: a hardcoded fee that drifts becomes an intent Circle rejects.
   */
  useEffect(() => {
    if (engine !== 'gateway' || !gwSource || !isGatewayChain(to)) return;
    let live = true;
    const read = async () => {
      try {
        const [bal, quote] = await Promise.all([
          gatewayBalance({ depositor: session.address }),
          quoteGatewaySpend({
            from: gwSource,
            to: to as GatewayChain,
            amount: 1_000_000n,
            depositor: session.address,
          }),
        ]);
        if (!live) return;
        const here = bal.byChain[gwSource] ?? 0n;
        // Clear anything Circle has caught up on before reading what is still out.
        reconcile(gwSource, here, gwOnSource ?? here);
        setGwOnSource(here);
        setGwByChain(bal.byChain);
        setGwPending(pendingOn(gwSource));
        setGwFee(quote.quotedFee);
        setGwCeiling(quote.maxFee);
      } catch {
        // Leave the last known figures rather than blanking the screen on one
        // failed poll. The button stays honest because it checks again before it acts.
      }
    };
    void read();
    const timer = setInterval(() => void read(), 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [engine, gwSource, to, session.address]);

  /**
   * The wallet's USDC on both ends of the route.
   *
   * One effect for both sides so the two figures can never describe different
   * moments, and one read function so neither side can quietly learn a different
   * rule about which chains are readable.
   */
  useEffect(() => {
    let live = true;
    const read = async () => {
      const [a, b] = await Promise.all([
        readUsdcOn(from, session.chainId, session.address as Address),
        readUsdcOn(to, session.chainId, session.address as Address),
      ]);
      if (!live) return;
      setWalletOnChain(a);
      setToBalance(b);
    };
    void read();
    const timer = setInterval(() => void read(), 20000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [from, to, session.address, session.chainId]);

  /**
   * Everything that described the old source chain, forgotten.
   *
   * The balance, the fee, the ceiling, the wallet holding and any amount typed
   * against them are all about one particular chain. Left in place when the chain
   * changes they do not go missing, which would be obvious; they go wrong, which
   * is not. The reads are keyed on the source, so clearing here and letting them
   * run again is the whole of the update.
   *
   * One function so there is one answer to "what does changing the source
   * invalidate", whether the change came from the picker in the funding box, the
   * From picker, or the arrow between them. Anything added later that depends on
   * the source is cleared here and is then correct in all three.
   */
  function forgetSourceReads() {
    setGwOnSource(null);
    setGwFee(null);
    setGwCeiling(null);
    setWalletOnChain(null);
    setGwPending(0n);
    setDepositAmount('');
  }

  /** The source chain, from whichever picker asked. */
  function selectSource(chain: CctpChainName) {
    if (chain === from) return;
    setFrom(chain);
    forgetSourceReads();
  }

  /** The destination. Cheaper to invalidate: only the quote depends on it, but it
   *  does depend on it, and a fee quoted for the previous destination is wrong. */
  function selectDest(chain: CctpChainName) {
    if (chain === to) return;
    setTo(chain);
    setGwFee(null);
    setGwCeiling(null);
  }

  function swapRoute() {
    if (from === to) return;
    setFrom(to);
    setTo(from);
    forgetSourceReads();
  }

  const activeSteps = engine === 'gateway' ? GATEWAY_STEPS : BRIDGE_STEPS;
  const stepLabel = (name: string) =>
    t(
      (engine === 'gateway'
        ? `bridge.gwstep.${name}`
        : `bridge.step.${name}`) as 'bridge.step.mint',
    );

  const steps: Step[] = useMemo(() => {
    // Which step is actually running, from the server, rather than lighting all of
    // them up for the duration. The job reports each one as it happens; before this
    // the indicator could only say "something is in progress" for half a minute.
    const reported = selfBridge?.steps ?? job?.steps ?? [];
    const finished = selfBridge ? selfBridge.state !== 'running' : job && job.state !== 'running';
    return activeSteps.map((name) => {
      const at = reported.findIndex((r) => r.name === name);
      if (finished) {
        const st = (reported[at] as { state?: string } | undefined)?.state;
        return {
          label: stepLabel(name),
          status: st === 'error' ? 'error' : at >= 0 ? 'done' : 'pending',
        };
      }
      if (at < 0) return { label: stepLabel(name), status: 'pending' };
      // The most recent report is the one still running; anything before it is done.
      const isLast = at === reported.length - 1;
      return { label: stepLabel(name), status: isLast ? 'active' : 'done' };
    }) as Step[];
  }, [job, selfBridge, activeSteps, t, engine]);

  /**
   * Which of these records paid for a subscription box.
   *
   * Told from the recipient rather than from a flag written when the record was
   * made: the box address is already on the record and the set of boxes is already
   * known, so there is nothing to store, nothing to migrate, and no way for a flag
   * to disagree with the transfer it describes. It also classifies records made
   * before subscriptions were funded this way at all.
   *
   * Read off the session cache rather than by scanning. An empty set means nothing
   * has been recognised yet, and every record lands in the ordinary half, which is
   * the honest answer when we do not know.
   */
  const { boxes: myBoxes, names: boxNames } = knownBoxes(session.address);

  /** Only the engine filter stays here; search, date and paging are the list's. */
  const filteredByEngine = useMemo(
    () =>
      bridges.filter(
        (b) =>
          (histEngine === 'all' || (b.engine ?? 'cctp') === histEngine) &&
          // The two halves are one list filtered twice, and complementary on
          // purpose: a record belongs to exactly one, so nothing shows up twice and
          // nothing falls out of both.
          isBoxFunding(b.recipient, myBoxes) === (histKind === 'subs'),
      ),
    [bridges, histEngine, histKind, myBoxes],
  );

  /**
   * Follow the running transfer, including one this browser did not start in this
   * page load. A reload used to lose the bridge entirely; the id outlives the tab,
   * so picking it back up is just reading it.
   */
  /**
   * Follow every running transfer, including ones this browser did not start in this
   * page load. A reload used to lose the bridge entirely; the ids outlive the tab, so
   * picking them back up is just reading them.
   */
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const ids = activeJobIds();
      if (!ids.length) return;
      const seen = await Promise.all(ids.map((id) => readBridgeJob(id)));
      if (!live) return;
      const got = seen.filter((j): j is BridgeJob => j !== null);
      setJobs(got);

      for (const next of got) {
        if (next.state === 'running' || saved.current.has(next.jobId)) continue;
        // Record once. The poll runs every two seconds, and a finished job would
        // otherwise be appended to history on every tick until the user left.
        saved.current.add(next.jobId);
        forgetJob(next.jobId);
        if (next.state !== 'unknown') {
          setResult({ state: next.state, amount: next.amount, steps: next.steps } as BridgeOutcome);
          saveBridge({
            id: next.jobId,
            engine: next.engine,
            from: next.from as BridgeChainName,
            to: next.to as BridgeChainName,
            fromLabel: bridgeChainLabel(next.from as BridgeChainName),
            toLabel: bridgeChainLabel(next.to as BridgeChainName),
            amount: next.amount,
            state: next.state,
            steps: next.steps.map((st) => ({
              name: st.name,
              ...(st.txHash ? { txHash: st.txHash } : {}),
              ...(st.explorerUrl ? { explorerUrl: st.explorerUrl } : {}),
            })),
            createdAt: next.startedAt,
          });
          setBridges(loadBridges());
        }
        toast.push(
          next.state === 'success' ? t('bridge.done') : next.error || t('bridge.failed'),
          next.state === 'success' ? 'success' : 'error',
        );
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [t, toast]);

  /**
   * Finish transfers that were interrupted between the burn and the mint.
   *
   * A wallet-signed bridge has no server job watching it, so closing the tab during
   * the wait used to leave a row saying "pending" with no way past it -- even though
   * the money had arrived. Nothing needs to be re-signed or re-sent to find out: the
   * burn hash is enough to ask Circle where it went, so every pending burn is asked
   * again on load and every half minute after.
   *
   * Recovery, not retry. It never touches the wallet and never moves funds.
   */
  useEffect(() => {
    let live = true;
    const resume = async () => {
      for (const b of loadBridges().filter((x) => x.state === 'pending')) {
        if ((b.engine ?? 'cctp') === 'gateway') {
          // Gateway's receipt is the transferId, and Circle answers on it forever.
          const status = await findGatewayMint({ transferId: b.id });
          if (!live || status.state === 'pending') continue;
          saveBridge({
            ...b,
            state: status.state === 'done' ? 'success' : 'error',
            steps:
              status.state === 'done' && status.mintTxHash
                ? [...b.steps, stepRow('mint', status.mintTxHash, b.to as CctpChainName)]
                : b.steps,
          });
          setBridges(loadBridges());
          if (status.state === 'done') {
            toast.push(t('bridge.recovered').replace('{amount}', b.amount), 'success');
          }
          continue;
        }
        const burnTxHash = b.steps.find((s) => s.name === 'burn')?.txHash;
        const source = CCTP_CHAINS[b.from as CctpChainName];
        if (!burnTxHash || !source) continue;
        const forward = await findForwardedMint({
          sourceDomain: source.domain,
          burnTxHash: burnTxHash as `0x${string}`,
        });
        if (!live || !forward) continue;
        saveBridge({
          ...b,
          state: 'success',
          steps: [
            ...b.steps,
            stepRow('fetchAttestation'),
            stepRow('mint', forward, b.to as CctpChainName),
          ],
        });
        setBridges(loadBridges());
        toast.push(t('bridge.recovered').replace('{amount}', b.amount), 'success');
      }
    };
    void resume();
    const timer = setInterval(() => void resume(), 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [t, toast]);

  /**
   * CCTP goes through the connected wallet; Gateway still goes through the server.
   *
   * They are genuinely different flows now, not two buttons on one. CCTP burns the
   * user's own USDC and Circle mints it back to them, so the browser signs and no
   * server key is involved. Gateway's kit is Node-first and cannot run here, so it
   * remains a relayer-funded job until it can.
   */
  /**
   * Put the wallet's own USDC into its Gateway balance.
   *
   * Separate from sending on purpose. The deposit is the only on-chain transaction
   * in Gateway and the only part that waits, and how long it waits depends entirely
   * on the chain: half a second on Arc, up to nineteen minutes on Base. Burying that
   * inside a "send" button would make one transfer mysteriously take a quarter of an
   * hour, and it is also a thing you do once and then stop thinking about.
   */
  /**
   * A submit guard that releases at dispatch, not at completion.
   *
   * Wrapping the whole transfer meant the button stayed locked for as long as the
   * wait lasted, which for CCTP is up to three minutes, and a second click in that
   * window was swallowed with no message and no disabled state. That is the same
   * "I pressed it and nothing happened" failure as the silent return, and it also
   * broke something that used to work: two transfers running at once. The guard
   * still stops a double-click, because it is only released once the first one has
   * a receipt, and by then the second is a deliberate second transfer.
   */
  function untilDispatched() {
    let release: () => void = () => {};
    const signal = new Promise<void>((r) => {
      release = r;
    });
    // Never hold the button forever if a transfer dies before its receipt.
    const bail = setTimeout(release, 60_000);
    return {
      signal,
      release: () => {
        clearTimeout(bail);
        release();
      },
    };
  }

  async function deposit() {
    if (!gwSource || depositValue <= 0n) return;
    setDepositing(true);
    setSelfBridge({ steps: [], state: 'running' });
    try {
      const res = await depositToGateway(
        bridgeClients(CCTP_CHAINS[gwSource].chainId, session.address),
        {
          chain: gwSource,
          amount: depositValue,
          onStep: (step, txHash) => {
            const name = GW_STEP_TO_UI[step];
            if (!name) return;
            setSelfBridge((prev) => ({
              state: 'running',
              steps: [
                ...(prev?.steps ?? []).filter((x) => x.name !== name),
                { name, ...(txHash ? { txHash } : {}) },
              ],
            }));
          },
        },
      );
      setSelfBridge(null);
      rememberDeposit(gwSource, depositValue);
      setGwPending(pendingOn(gwSource));
      setDepositAmount('');
      toast.push(
        t('bridge.deposited')
          .replace('{amount}', depositAmount)
          .replace('{wait}', waitLabel(gwSource)),
        'success',
      );
      void res;
    } catch (e) {
      setSelfBridge(null);
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setDepositing(false);
    }
  }

  /**
   * Start a transfer and return as soon as it has a receipt.
   *
   * The waiting continues in the background: the row is already written, the
   * recovery pass will finish it if this page goes away, and the form is usable
   * again immediately. Holding the caller until the mint lands was what locked the
   * button for minutes at a time.
   */
  async function run() {
    const dispatch = untilDispatched();
    void runToCompletion(dispatch).catch(() => dispatch.release());
    await dispatch.signal;
  }

  async function runToCompletion(dispatch: ReturnType<typeof untilDispatched>) {
    setResult(null);
    if (engine === 'gateway') {
      // Should be unreachable: the button is disabled without both chains. Kept as
      // a spoken refusal rather than a silent `return`, because a button that does
      // nothing at all and says nothing is indistinguishable from a broken app, and
      // that is exactly how this read when it happened.
      if (!gwSource || !isGatewayChain(to)) {
        toast.push(t('bridge.gwChainMissing'), 'error');
        dispatch.release();
        return;
      }
      setSelfBridge({ steps: [], state: 'running' });
      try {
        // No wallet client bound to a chain: a spend is a signature, so it works
        // wherever the wallet happens to be.
        const res = await spendFromGateway(
          { walletClient: session.clients.walletClient },
          {
            from: gwSource,
            to: to as GatewayChain,
            amount: parseUnits(amount, 6),
            ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() as Address } : {}),
            onStep: (step, txHash) => {
              const name = GW_STEP_TO_UI[step];
              if (!name) return;
              setSelfBridge((prev) => ({
                state: 'running',
                steps: [
                  ...(prev?.steps ?? []).filter((x) => x.name !== name),
                  { name, ...(txHash ? { txHash } : {}) },
                ],
              }));
            },
            // Write the receipt down the moment Circle accepts the intent, not when
            // the mint lands. The wait in between is where a tab gets closed, and
            // without this the transferId would be gone with it.
            onTransferId: (transferId) => {
              dispatch.release();
              saveBridge({
                id: transferId,
                engine: 'gateway',
                from,
                to,
                fromLabel,
                toLabel,
                amount,
                ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() } : {}),
                state: 'pending',
                steps: [{ name: 'deposit' }, { name: 'sign' }, { name: 'attestation' }],
                createdAt: Date.now(),
              });
              setBridges(loadBridges());
            },
          },
        );
        const steps = [
          { name: 'deposit' },
          { name: 'sign' },
          { name: 'attestation' },
          ...(res.mintTxHash ? [stepRow('mint', res.mintTxHash, to)] : []),
        ];
        setSelfBridge({ state: res.mintTxHash ? 'success' : 'running', steps });
        saveBridge({
          // The transferId is the receipt here, the way the burn hash is for CCTP.
          id: res.transferId,
          engine: 'gateway',
          from,
          to,
          fromLabel,
          toLabel,
          amount,
          ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() } : {}),
          state: res.mintTxHash ? 'success' : 'pending',
          steps,
          createdAt: Date.now(),
        });
        setBridges(loadBridges());
            setGwOnSource(null);
        toast.push(
          res.mintTxHash ? t('bridge.done') : t('bridge.forwardPending'),
          res.mintTxHash ? 'success' : 'info',
        );
      } catch (e) {
        setSelfBridge(null);
        toast.push(e instanceof Error ? e.message : String(e), 'error');
      } finally {
        dispatch.release();
      }
      return;
    }

    setSelfBridge({ steps: [], state: 'running' });
    try {
      // Clients bound to the source chain, not to Arc. The wallet is already there
      // -- the button would have offered to switch otherwise -- but the app's own
      // client is pinned to Arc and would tag the burn with the wrong chain id.
      const res = await bridgeFromWallet(
        bridgeClients(CCTP_CHAINS[from].chainId, session.address),
        {
          from,
          to,
          amount: parseUnits(amount, 6),
          ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() as Address } : {}),
          onStep: (step, txHash) => {
            const name = SDK_STEP_TO_UI[step];
            if (!name) return; // quoting is instant; it has no row in the stepper
            setSelfBridge((prev) => ({
              state: 'running',
              steps: [
                ...(prev?.steps ?? []).filter((x) => x.name !== name),
                { name, ...(txHash ? { txHash } : {}) },
              ],
            }));
            // Write the burn down the moment it confirms, not when the whole
            // transfer resolves. The wait for Circle is the long part and a reload
            // during it would otherwise lose the one hash the money can be traced
            // and recovered from. `pending` is honest: burned, not yet minted.
            if (step === 'burn' && txHash) {
              dispatch.release();
              saveBridge({
                id: txHash,
                engine: 'cctp',
                from,
                to,
                fromLabel,
                toLabel,
                amount,
                ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() } : {}),
                state: 'pending',
                steps: [stepRow('burn', txHash, from)],
                createdAt: Date.now(),
              });
              setBridges(loadBridges());
            }
          },
        },
      );
      const steps = [
        ...(res.approveTxHash ? [stepRow('approve', res.approveTxHash, from)] : []),
        stepRow('burn', res.burnTxHash, from),
        // The attestation has no transaction of its own, but leaving it out of the
        // final list left it showing as pending underneath a completed mint.
        ...(res.forwardTxHash
          ? [stepRow('fetchAttestation'), stepRow('mint', res.forwardTxHash, to)]
          : []),
      ];
      setSelfBridge({ state: res.forwardTxHash ? 'success' : 'running', steps });
      saveBridge({
        id: res.burnTxHash,
        engine: 'cctp',
        from,
        to,
        fromLabel,
        toLabel,
        amount,
        ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() } : {}),
        // No forward hash yet is not a failure: the burn is permanent and Circle
        // will still mint. Recording it as pending keeps the receipt either way.
        state: res.forwardTxHash ? 'success' : 'pending',
        steps,
        createdAt: Date.now(),
      });
      setBridges(loadBridges());
      toast.push(
        res.forwardTxHash ? t('bridge.done') : t('bridge.forwardPending'),
        res.forwardTxHash ? 'success' : 'info',
      );
    } catch (e) {
      setSelfBridge(null);
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      dispatch.release();
    }
  }

  return (
    <>
      {/* What the selected route does, behind the title. It is three bullets of
          mechanism -- burn here, attest, mint there -- which is worth having and is
          not what anyone opened this tab to read. The dot beside the tabs is a
          different question (which route should I pick) and stays with the tabs. */}
      <Card
        title={t(`bridge.${engine}.title`)}
        infoLabel={t(`bridge.${engine}.title`)}
        info={
          <>
            <p>{t(`bridge.${engine}.body`)}</p>
            <ul className="hintlist">
              <li>{t(`bridge.${engine}.point1`)}</li>
              <li>{t(`bridge.${engine}.point2`)}</li>
              <li>{t(`bridge.${engine}.point3`)}</li>
            </ul>
          </>
        }
        data-testid="bridge-tab"
      >
        <div className="bridge-engine">
          <SegmentedTabs
            tabs={[
              { id: 'cctp', label: t('bridge.engine.cctp') },
              { id: 'gateway', label: t('bridge.engine.gateway') },
            ]}
            value={engine}
            onChange={changeEngine}
          />
          <InfoPopover label={t('bridge.info.aria')}>
            <div className="infopop__item">
              <span className="infopop__k">{t('bridge.info.cctpTitle')}</span>
              <p>{t('bridge.info.cctpBody')}</p>
            </div>
            <div className="infopop__item">
              <span className="infopop__k">{t('bridge.info.gatewayTitle')}</span>
              <p>{t('bridge.info.gatewayBody')}</p>
            </div>
          </InfoPopover>
        </div>

        {/*
          Funding the balance comes first, because in Gateway it happens first.

          A transfer here spends a balance that has to already exist, so putting
          the thing that creates it above the route is the order the product
          actually works in. It also stops the deposit reading as a footnote to a
          transfer: it is not, and someone who only wants to top up should not have
          to scroll past a form they are not filling in.
        */}
        {engine === 'gateway' && (
          <GatewayFundBox
            chain={from}
            chainOptions={chainOptions}
            onChainChange={(v) => selectSource(v as CctpChainName)}
            balance={gwOnSource}
            maxDeposit={maxDeposit}
            amount={depositAmount}
            onAmountChange={setDepositAmount}
            walletOnChain={walletOnDepositChain}
            pending={gwPending}
            wait={t('bridge.gwDepositWait', { chain: fromLabel, wait: waitLabel(gwSource) })}
            format={usdc}
            busy={depositing || switching}
            onDeposit={() =>
              void (async () => {
                // Being on the wrong network is a step, not a refusal: move the
                // wallet, then deposit, rather than sending the user to find the
                // network switcher and come back.
                if (!walletOnDepositChain && gwSource) {
                  setSwitching(true);
                  try {
                    await switchWalletChain(CCTP_CHAINS[gwSource].chainId, fromLabel);
                  } catch (e) {
                    toast.push(e instanceof Error ? e.message : String(e), 'error');
                    return;
                  } finally {
                    setSwitching(false);
                  }
                }
                await guard(deposit);
              })()
            }
          />
        )}

        {/*
          Two cards and a flip between them, the shape every swap screen uses.

          The old row was two dropdowns labelled From and To with the amount in a
          third field underneath, which asked the reader to hold the route in their
          head while typing into something that named neither end of it. Here the
          amount sits inside the card of the chain it leaves, the balance it draws
          on is on the same line, and the second card shows what arrives.
        */}
        <div className="swapstack" style={{ marginTop: 16 }}>
          <div className="swapcard" data-testid="bridge-from-card">
            <div className="swapcard__head">
              <span className="swapcard__label">{t('bridge.from')}</span>
              <Select
                value={from}
                options={chainOptions}
                onChange={(v) => selectSource(v as CctpChainName)}
                ariaLabel={t('bridge.from')}
                searchable
                searchPlaceholder={t('bridge.searchChain')}
                noResultsText={t('common.noResults')}
              />
            </div>
            <AmountField
              value={amount}
              onChange={setAmount}
              chain={from}
              // The balance, not the spendable figure. Labelling "Gateway balance"
              // over a number that already had the fee taken out of it contradicts
              // the box above, which shows the real one. What the label says and
              // what tapping it fills in are allowed to differ; what the label says
              // and what it is are not.
              balance={spendable}
              balanceLabel={
                engine === 'gateway' ? t('bridge.gwBalanceLabel') : t('bridge.balance')
              }
              onMax={fillPercent}
              percents={[0.25, 0.5]}
              data-testid="bridge-amount"
            />
          </div>

          {/* In the gap between the cards, painted in the page background so it
              reads as a cut-out rather than a third element. */}
          <div className="swapstack__flip">
            <button
              type="button"
              onClick={swapRoute}
              title={t('bridge.swap')}
              aria-label={t('bridge.swap')}
              data-testid="bridge-swap-route"
            >
              &darr;
            </button>
          </div>

          <div className="swapcard" data-testid="bridge-to-card">
            <div className="swapcard__head">
              <span className="swapcard__label">{t('bridge.to')}</span>
              <Select
                value={to}
                options={chainOptions}
                onChange={(v) => selectDest(v as CctpChainName)}
                ariaLabel={t('bridge.to')}
                searchable
                searchPlaceholder={t('bridge.searchChain')}
                noResultsText={t('common.noResults')}
              />
            </div>
            {/* What arrives, not a second thing to fill in. Gateway takes its fee
                out of the balance rather than out of the transfer, and CCTP's comes
                off the sender's side too, so the figure is the same one. */}
            <AmountField
              value={amount}
              onChange={() => {}}
              readOnly
              chain={to}
              balance={toBalance}
              balanceLabel={t('bridge.balance')}
              label={t('bridge.youReceive')}
              data-testid="bridge-receive"
            />
          </div>
        </div>

        {sameChain && !gwWithdraw && (
          <p className="gwfund__err" data-testid="bridge-samechain">
            {t('bridge.sameChain')}
          </p>
        )}
        {gwWithdraw && <p className="hint">{t('bridge.withdrawHint')}</p>}
        {/* Whose money moves is the thing that changed, so say it plainly rather
            than leaving the user to infer it from a MetaMask prompt. */}
        {engine === 'cctp' && !walletOnSource && (
          <p className="hint" data-testid="bridge-selfnote">
            {t('bridge.wrongSourceChain').replace('{chain}', fromLabel)}
          </p>
        )}

        {/*
          What this costs, before it is agreed to.
          The fee is not small and it depends on the route rather than the amount:
          the same transfer costs 0.055 to Base and sixteen times that to Ethereum
          Sepolia, because it pays for gas on the destination. Learning that from
          the balance afterwards is not an acceptable way to learn it.
        */}
        {(gwFee != null || gwCeiling != null) && engine === 'gateway' && (
          <div
            className={`feecard ${feeSteep ? 'feecard--warn' : ''}`}
            data-testid="bridge-fee-card"
          >
            <div className="feecard__row">
              <span className="feecard__k">{t('bridge.feeLabel')}</span>
              <span className="feecard__v" data-testid="bridge-fee">
                {gwFee == null ? '…' : `${usdc(gwFee)} USDC`}
              </span>
            </div>
            {amountValue > 0 && gwNeeded != null && (
              <>
                <div className="feecard__sep" />
                <div className="feecard__row">
                  <span className="feecard__k">{t('bridge.youPay')}</span>
                  <span className="feecard__v feecard__v--big" data-testid="bridge-youpay">
                    {usdc(gwNeeded)} USDC
                  </span>
                </div>
              </>
            )}
            {feeSteep && (
              <p className="feecard__warn" data-testid="bridge-fee-steep">
                {t('bridge.feeOverAmount')}
              </p>
            )}
          </div>
        )}

        {/* One line, and the button that fixes it. Naming the problem and leaving
            the user to find the chain picker is most of the way to not saying it. */}
        {refusal && (
          <div className="refusal" data-testid="bridge-refusal">
            <p className="refusal__msg">
              {t(`bridge.refusal.${refusal.code}` as never, refusal.params)}
            </p>
            {refusal.fix && (
              <Button variant="ghost" onClick={applyFix} data-testid="bridge-refusal-fix">
                {refusal.fix.kind === 'switchSource'
                  ? t('bridge.fixSwitch').replace('{chain}', refusal.fix.label)
                  : refusal.fix.kind === 'deposit'
                    ? t('bridge.fixDeposit').replace('{amount}', refusal.fix.display)
                    : t('bridge.fixMax').replace('{amount}', refusal.fix.display)}
              </Button>
            )}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <Field
            label={t('bridge.recipient')}
            hint={t('bridge.recipientHint')}
            {...(recipientBad ? { error: t('bridge.recipientBad') } : {})}
          >
            <Input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={t('bridge.recipientPlaceholder')}
              data-testid="bridge-recipient"
            />
          </Field>
        </div>

        {/* Same firewall as the send screen, same verdict, same block, and now
            the same reasons: this used to render the rule card only, so a bridge
            could refuse on an advisory the user was never shown. */}
        <RiskGate gate={risk} recoverable={false} data-testid="bridge-risk" />

        {(result || job || selfBridge) && <Stepper steps={steps} highlightIndex={hoverIdx} />}

        <div style={{ marginTop: 16 }}>
          {/* Being on the wrong network is a step, not a failure. Offering the
              switch is one click; a disabled button is a dead end. */}
          {!walletOnSource && cctpSource ? (
            <Button
              full
              disabled={switching}
              data-testid="bridge-switch"
              onClick={() =>
                void (async () => {
                  setSwitching(true);
                  try {
                    await switchWalletChain(cctpSource.chainId, fromLabel);
                  } catch (e) {
                    toast.push(e instanceof Error ? e.message : String(e), 'error');
                  } finally {
                    setSwitching(false);
                  }
                })()
              }
            >
              {t('bridge.switchTo').replace('{chain}', fromLabel)}
            </Button>
          ) : (
            <Button
              full
              onClick={() => void guard(run)}
              disabled={!canSend}
              data-testid="bridge-button"
            >
              {gwWithdraw
                ? t('bridge.withdrawButton')
                : running > 0
                  ? t('bridge.buttonAnother')
                  : t('bridge.button')}
            </Button>
          )}
        </div>
        {!bridgeEnabled && <p className="hint">{t('bridge.noKey')}</p>}

        {/* A bridge can come back 200 and still have failed at a step. Rendering only
            the success case left the screen unchanged, which reads as "the button
            does nothing" rather than "CCTP refused this amount". */}
        {result && result.state !== 'success' && (
          <div className="risk risk--block" style={{ marginTop: 14 }} data-testid="bridge-error">
            <div className="risk__head">{t('bridge.failed')}</div>
            <ul className="risk__reasons">
              {result.steps
                .filter((s) => s.state !== 'success')
                .map((s) => (
                  <li key={s.name} className="risk__reason risk__reason--block">
                    {stepLabel(activeSteps[stepIndexFor(s.name, activeSteps)] ?? 'mint')}
                    {s.error ? `: ${s.error}` : ''}
                  </li>
                ))}
            </ul>
          </div>
        )}

        {result?.state === 'success' && (
          <div className="row wrap" style={{ marginTop: 14 }} data-testid="bridge-success">
            {result.steps
              .filter((s) => s.txHash && safeHttpUrl(s.explorerUrl))
              .map((s) => (
                <TxLink
                  key={s.name}
                  href={safeHttpUrl(s.explorerUrl)}
                  label={s.name}
                  copyValue={s.txHash ?? ''}
                  title={stepLabel(activeSteps[stepIndexFor(s.name, activeSteps)] ?? 'mint')}
                  onMouseEnter={() => setHoverIdx(stepIndexFor(s.name, activeSteps))}
                  onMouseLeave={() => setHoverIdx(null)}
                />
              ))}
          </div>
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card
          title={t(histKind === 'subs' ? 'bridge.historySubsTitle' : 'bridge.historyTitle')}
          data-testid="bridge-history"
        >
          {/* Two halves of one list. Written as a second component they would be two
              copies of the filtering, paging and day grouping below, and the first
              change to either is where they would start disagreeing. */}
          <div className="bridge-engine" style={{ marginBottom: 12 }}>
            <SegmentedTabs
              tabs={[
                { id: 'bridge', label: t('bridge.historyKindBridge') },
                { id: 'subs', label: t('bridge.historyKindSubs') },
              ]}
              value={histKind}
              onChange={(v) => setHistKind(v as 'bridge' | 'subs')}
            />
          </div>
          <HistoryList
            items={filteredByEngine}
            data-testid="bridge-history-list"
            searchText={bridgeHaystack}
            timestamp={(b) => b.createdAt}
            rowKey={(b) => b.id}
            searchPlaceholder={t('bridge.historySearch')}
            emptyText={t('bridge.historyEmpty')}
            noMatchText={t('bridge.historyNoMatch')}
            pageSize={HISTORY_PAGE_SIZE}
            control={{
              value: histEngine,
              ariaLabel: t('bridge.filterEngine'),
              onChange: (v) => setHistEngine(v as 'all' | BridgeEngine),
              options: [
                { value: 'all', label: t('bridge.filterAll') },
                { value: 'cctp', label: t('bridge.engine.cctp') },
                { value: 'gateway', label: t('bridge.engine.gateway') },
              ],
            }}
            renderRow={(b) => (
              <HistoryRow data-testid="bridge-history-row">
                <HistoryRow.Head
                  lead={
                    <>
                      <ChainLogo id={b.from} size={18} />
                      {b.fromLabel}
                      <span className="hrow__arrow" aria-hidden>
                        &rarr;
                      </span>
                      <ChainLogo id={b.to} size={18} />
                      {b.toLabel}
                      {/* On a funding row the destination chain is always Arc and
                          always the same, so what the row is actually about is
                          which subscription it paid for. */}
                      {histKind === 'subs' && b.recipient && (
                        <span className="hrow__for">
                          {boxNames.get(b.recipient.toLowerCase()) ?? short(b.recipient)}
                        </span>
                      )}
                    </>
                  }
                  amount={`${b.amount} USDC`}
                  status={{
                    tone: b.state === 'success' ? 'ok' : b.state === 'error' ? 'err' : 'idle',
                    label: t(`bridge.state.${b.state}` as 'bridge.state.success'),
                  }}
                  time={relativeTime(b.createdAt)}
                />
                {/* A recipient is only shown when the money went to someone else.
                    Printing the sender's own address as a "to" is noise. */}
                {(b.recipient || b.id) && (
                  <HistoryRow.Facts>
                    {b.recipient && (
                      <HistoryRow.Fact label={t('bridge.rowTo')}>
                        <AddressChip address={b.recipient} />
                      </HistoryRow.Fact>
                    )}
                    <HistoryRow.Fact label={t('bridge.rowReceipt')}>
                      <Copyable value={b.id} display={short(b.id)} />
                    </HistoryRow.Fact>
                  </HistoryRow.Facts>
                )}
                <HistoryRow.Steps steps={b.steps.map((s) => rowStep(s, t))} />
              </HistoryRow>
            )}
          />
        </Card>
      </div>
    </>
  );
}
