import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@ctrl-arcz/demo-kit';
import { isAddress, parseUnits, type Address } from 'viem';
import {
  bridgeFromWallet,
  chainExplorerTxUrl,
  findForwardedMint,
  findGatewayMint,
  gatewayBalance,
  depositToGateway,
  spendFromGateway,
  quoteGatewaySpend,
  isGatewayChain,
  CCTP_CHAINS,
  DEPOSIT_CONFIRMATION_SECONDS,
  usdc,
  percentOf,
  maxDeliverable,
  maxDepositable,
  gatewayShortfall,
  cctpShortfall,
  isBoxFunding,
  type CctpChainName,
  type CctpStep,
  type GatewayChain,
  type GatewayStep,
  type SourceBalance,
} from '@ctrl-arcz/sdk';
import {
  bridgeClients,
  destinationChain,
  switchWalletTo,
  useWalletChain,
} from '@ctrl-arcz/demo-kit';
import { knownBoxes } from '../lib/useSubscriptions.js';
import {
  chainForStep,
  chainsFor,
  labelOf,
  ownedBy,
  stepIndexFor,
  stepsForEngine,
  type BridgeEngine,
  type BridgeOutcome,
} from '@ctrl-arcz/demo-kit';
import {
  AmountField,
  Button,
  Card,
  ChainLogo,
  ChainSelect,
  CostBlock,
  Field,
  GatewayFundBox,
  InfoBody,
  Input,
  SegmentedTabs,
  GatewaySources,
  Notice,
  gatewayFeeLines,
  gatewayPlan,
  type GatewaySource,
  ActivityBlock,
  HistoryList,
  HistoryRow,
  Address as AddressChip,
  Copyable,
  relativeTime,
  short,
  TxLink,
  useSubmitGuard,
  useT,
  useToast,
  type RowStep,
} from '@ctrl-arcz/demo-kit/ui';
import { loadBridges, saveBridge, type StoredBridge, type StoredBridgeStep } from '../store.js';
import { useRecipientGate } from '../lib/useRecipientGate.js';
import { RiskGate } from './RiskGate.js';
import { pendingOn, rememberDeposit } from '../lib/pendingDeposits.js';
import { failureNote, startRun, useActivity } from '../lib/activity.js';
import { activityLabels, toActivityItem } from '../lib/activityView.js';
import { useGatewayBalances, useWalletUsdc } from '../lib/balances.js';
import { bumpBalances } from '../lib/balanceStore.js';

// The wallet signs both engines, so there is no key here to gate on. A plain flag
// is enough to hide the tab where a deployment does not want it.
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

/**
 * What a deposit leaves behind for its own gas, on chains that charge it in USDC.
 *
 * Measured rather than guessed: an approve plus a deposit on Arc costs a little
 * under a hundredth of a USDC, and this is that rounded up. Being generous here
 * costs a cent of headroom; being tight produces a Max that reverts, which is the
 * one outcome a Max button must never have.
 */
const DEPOSIT_GAS_RESERVE = 10_000n;

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
 * The same row, with the chain worked out from what the step is rather than
 * handed in.
 *
 * Every call site used to pass the transfer's source for every step, which put a
 * mint on the source chain's explorer. `chainForStep` is the one place that knows
 * an approval is on the source and a mint is at the far end.
 */
function routedStep(
  name: string,
  txHash: string | undefined,
  route: { engine: BridgeEngine; from: CctpChainName; to: CctpChainName },
) {
  return stepRow(name, txHash, chainForStep(name, route));
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
  /**
   * The destination the user picked, or null while it is still the default.
   *
   * Null is not "no destination": it is "nobody has said", which lets the rule in
   * `destinationChain` keep answering as the source moves. Storing the derived
   * chain instead would freeze the first answer, so a bridge that opened on Arc to
   * Base and then had its source changed to Arc would sit on a route from a chain
   * to itself.
   */
  const [toChoice, setToChoice] = useState<CctpChainName | null>(null);
  /** Set while the wallet is being asked to move to the source chain. */
  const [switching, setSwitching] = useState(false);

  /**
   * Every chain this engine can serve, asked of the catalog rather than spelled
   * out here. Gateway's list is the shorter one, and which chains are on it is not
   * a fact this screen should be holding a copy of.
   */
  const engineChains: readonly CctpChainName[] = chainsFor(
    engine === 'gateway' ? 'gatewayDeposit' : 'cctpSource',
  );

  /** One label rule for the whole app; this screen used to carry a second. */
  const labelFor = (id: string) => labelOf(id);

  /**
   * The source chain and the wallet, on the same network in both directions.
   *
   * This screen opened on a hardcoded Arc regardless of where the wallet was, so a
   * wallet connected to Ethereum Sepolia met a form offering to burn USDC on Arc,
   * showed Arc's balance, and explained underneath that the wallet would have to
   * move first. Every fact needed to open on the right chain was already on screen,
   * in the header chip.
   *
   * Now the wallet's network is where this starts, and picking a different one here
   * moves the wallet: the source chain is where the burn or the deposit is signed,
   * so choosing it and then being asked to confirm the same choice on a second
   * button was one step too many. The button below stays for the case that step
   * exists to handle -- a switch the user declines.
   */
  const source = useWalletChain<CctpChainName>({
    options: engineChains,
    chainIdOf: (name) => CCTP_CHAINS[name].chainId,
    walletChainId: session.chainId,
    fallback: 'Arc_Testnet',
    switchWallet: (chainId, name) =>
      switchWalletTo(chainId, labelFor(name)).catch((e: unknown) => {
        toast.fail(e);
      }),
    // Everything read for the old chain describes the old chain, whether it changed
    // here or in MetaMask.
    onChange: () => forgetSourceReads(),
  });
  const from = source.value;
  /**
   * The other end, which is the one control here that does not follow the wallet.
   *
   * Nothing is signed at the destination, so there is nothing for the wallet to
   * follow. It defaults to Arc, because bringing money to Arc is what this app is
   * for, and steps aside when the source is already Arc.
   */
  /**
   * Where the money lands.
   *
   * CCTP has to keep the two ends apart: it burns on one chain and mints on
   * another, and a bridge to the chain you are standing on does nothing. Gateway
   * does not, and the rule was quietly breaking it -- `from` there is only the
   * chain the deposit box is pointed at, so picking Arc as the destination while
   * the box happened to be on Arc silently bounced the choice back to Ethereum.
   * Same-chain is a real Gateway transfer besides: it is how money comes back out.
   */
  const to =
    engine === 'gateway'
      ? ((toChoice && engineChains.includes(toChoice) ? toChoice : 'Arc_Testnet') as CctpChainName)
      : destinationChain(engineChains, from, toChoice, 'Arc_Testnet');
  /** Which half of the bridge records the history is showing. */
  const [histKind, setHistKind] = useState<'bridge' | 'subs'>('bridge');
  /**
   * Per chain, because that is what a transfer actually spends. Showing only the
   * total would tell someone with money on Arc that they can send from Base.
   */
  /*
   * The Gateway balance comes from the shared store, not a per-tab read: switching
   * to this tab shows the last-known figure at once and refreshes behind it, and a
   * bridge that spends it bumps every screen watching the same balance. `gwOnSource`
   * and `gwByChain` are derived from it below, once the source chain is known.
   */
  const gatewayBal = useGatewayBalances(session.address as Address);
  /** Deposited, on chain, but not yet counted by Circle. */
  const [gwPending, setGwPending] = useState<bigint>(0n);
  /**
   * The fee ceiling: the padded figure that gets signed, that the balance has to
   * cover, and that the cost block quotes.
   *
   * There used to be a second figure beside it, the quote Circle actually charges,
   * shown as the fee while the total underneath added the ceiling. Two numbers that
   * differ by the margin, one line apart, and only one of them consistent with the
   * balance check. The ceiling is the one every other part of the screen already
   * uses, so it is the one the screen says out loud.
   */
  /**
   * The destination's forwarding fee, which is the only part of the cost that has
   * to be asked for.
   *
   * Base fees per chain are a measured table in the SDK, but forwarding is set by
   * the chain being paid into and moves with its gas: about 0.016 into Arc against
   * 0.054 into Avalanche, and two percent between two reads minutes apart. So the
   * poll below asks Circle for it and everything else on this screen is arithmetic
   * over the balances the app already has.
   */
  const [gwForwarding, setGwForwarding] = useState<bigint | null>(null);
  /**
   * Which networks the spend draws from, and how much of it each carries.
   *
   * A Gateway balance is one figure spread over several chains and a transfer can
   * draw on any number of them under a single signature. So "From" is a list of
   * networks rather than one chain -- but not a list of amounts: the payment is
   * still one figure, typed once, and an empty `amount` here means the allocator
   * divides it. A row typed into overrules the allocator for that chain.
   *
   * Starts as one network on whichever chain the route already named, so someone
   * who only ever sends from one place never learns that any of this exists.
   */
  const [gwSources, setGwSources] = useState<GatewaySource[]>(() => [
    { chain: (isGatewayChain(from) ? from : 'Arc_Testnet') as GatewayChain, amount: '' },
  ]);
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
  /*
   * The wallet's USDC on both ends, from the shared store. `walletOnChain` (source)
   * and `toBalance` (destination) are `null` both before a read and after one that
   * could not be made; `walletRead` is whether both have been attempted, which
   * tells a shimmer ("a number is coming") from a dash ("nothing is on its way, the
   * wallet is on another network").
   */
  const fromWallet = useWalletUsdc(from, session.chainId, session.address as Address);
  const toWallet = useWalletUsdc(to, session.chainId, session.address as Address);
  const walletOnChain = fromWallet.value ?? null;
  const toBalance = toWallet.value ?? null;
  const walletRead = fromWallet.resolved && toWallet.resolved;
  /**
   * Empty means "send it to myself", which is what a bridge normally is. Typing an
   * address here turns the transfer into a payment, and a payment to a hand-typed
   * address is exactly where poisoning lives -- so it goes through the same
   * firewall the send screen uses, not a second, laxer copy of it.
   */
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('0.1');
  /**
   * The last finished transfer, tagged with the engine that performed it, because
   * the receipt block below reads its step names against the engine on screen. An
   * untagged CCTP result rendered on the Gateway tab labelled its burn "Minting on
   * the destination chain", which is the same lie the stepper was telling.
   */
  const [result, setResult] = useState<(BridgeOutcome & { engine: BridgeEngine }) | null>(null);
  /** The transfer this wallet is signing right now. */
  /**
   * Which wallet-signed run owns the slot above.
   *
   * A Gateway screen can be funding and spending at the same time, and both write
   * here. Without an identity the first to finish would call `setSelfBridge(null)`
   * and wipe the other one's live progress, which reads as a transfer that stopped
   * happening. A finisher now only clears the slot if the slot is still its own.
   */
  const [bridges, setBridges] = useState<StoredBridge[]>(() => loadBridges());
  /**
   * The row this screen has just created, for the block to point at once.
   *
   * The form no longer draws progress, so without this a transfer would start and
   * the screen would say nothing until somebody thought to scroll. Set wherever a
   * record is first written, cleared by the block as soon as it has been seen or
   * followed.
   */
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [histEngine, setHistEngine] = useState<'all' | BridgeEngine>('all');
  /*
   * The same records, read the live way, for the block at the bottom.
   *
   * `bridges` above stays as it is: the recovery pass walks it, writes to it and
   * re-reads it at points of its own choosing, and rewiring that is a separate
   * change to a piece of code whose job is finishing transfers that were
   * interrupted. This is a second reader of one store, not a second store.
   */
  const activity = useActivity();

  const risk = useRecipientGate(session, recipient);
  const recipientBad = recipient.trim() !== '' && !isAddress(recipient.trim());
  /**
   * What is being sent, whichever engine is asking. One field, both engines.
   *
   * It was two for a while: Gateway put an amount on every source card and summed
   * them, which meant the fix a refusal offered ("send 3.62 instead") wrote to a
   * state Gateway no longer read, and the percentage chips filled in a field that
   * was not on screen. A payment is one figure; how many chains carry it is a
   * separate question, answered below by `gwSources`.
   */
  const amountValue = Number(amount);
  /**
   * Both ends the same chain.
   *
   * On CCTP that is the From picker matching the To picker, and it is refused.
   * On Gateway there is no single "from" any more, so the question becomes
   * whether the only chain paying is also the one being paid -- which is not a
   * mistake there but a withdrawal, and the note below says so.
   */
  const sameChain =
    engine === 'gateway'
      ? gwSources.length === 1 && gwSources[0]?.chain === (to as string)
      : from === to;

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
  // Derived from the shared store: what Gateway holds on every chain, and the
  // figure on the chosen source. Null while the first read is still out, so the
  // funding box can tell "loading" from "zero".
  const gwByChain = gatewayBal.value ?? {};
  const gwOnSource =
    engine === 'gateway' && gwSource && gatewayBal.value ? (gwByChain[gwSource] ?? 0n) : null;
  const gwTotal = gatewayBal.value
    ? Object.values(gwByChain).reduce((sum, v) => sum + v, 0n)
    : null;

  /**
   * Every chain that holds something, as the allocator wants it.
   *
   * Confirmed balances only. `useGatewayBalances` reads Circle's own figure, which
   * counts a deposit once it has the confirmations Circle requires, so a deposit
   * made seconds ago on a slow chain is simply not in here. That is the honest
   * reading: counting it would produce an intent Circle refuses, after the
   * signature.
   */
  const gwBalances = useMemo<SourceBalance[]>(
    () =>
      (Object.entries(gwByChain) as [GatewayChain, bigint][])
        .filter(([, balance]) => balance > 0n)
        .map(([chain, balance]) => ({ chain, balance })),
    [gwByChain],
  );

  /**
   * What the source cards add up to, and whether it can be sent.
   *
   * Derived on every keystroke, never stored: a kept allocation is one that
   * survives a change to the cards, the destination or the balance, and each of
   * those makes it wrong in a way that only surfaces at signing time.
   *
   * The same function the cards themselves render from, so the screen and the
   * button cannot come to different conclusions about the same payment.
   */
  const gwWanted = Number.isFinite(amountValue) && amountValue > 0
    ? BigInt(Math.round(amountValue * 1e6))
    : 0n;
  const gwPlan = useMemo(
    () =>
      engine === 'gateway' && gwForwarding != null
        ? gatewayPlan({
            amount: gwWanted,
            sources: gwSources,
            balances: gwBalances,
            forwarding: gwForwarding,
          })
        : null,
    [engine, gwWanted, gwSources, gwBalances, gwForwarding],
  );
  const gwAmount = gwPlan?.amount ?? 0n;
  const gwAlloc = gwPlan?.allocation ?? null;

  /**
   * What actually arrives at the other end.
   *
   * Not `amount - shortfall`, which was the first attempt and went NEGATIVE on
   * screen: the shortfall counts the fees that could not be covered either, so
   * asking a chain holding 0.03 for 7 reported a shortfall of 7.022626 and the
   * largest figure on the page read "-0.022626".
   *
   * Asked of the same function the Max button uses instead, over the chains the
   * cards actually name, and never more than was asked for.
   */
  const gwDeliverable = useMemo(() => {
    if (gwAmount <= 0n || gwForwarding == null) return 0n;
    if (gwAlloc && gwAlloc.shortfall === 0n) return gwAmount;
    const listed = new Set(gwSources.map((s) => s.chain));
    const reach = maxDeliverable({
      balances: gwBalances,
      forwarding: gwForwarding,
      allow: (c) => listed.has(c),
    });
    return reach < gwAmount ? reach : gwAmount;
  }, [gwAmount, gwAlloc, gwSources, gwBalances, gwForwarding]);

  // What Circle charges, and what the balance has to cover, which are not the
  // same number: the signature authorises a ceiling near twice the charge so a
  // doubling of gas between quoting and settling still goes through.
  const gwCeiling = gwAlloc && gwAlloc.legs.length > 0 ? gwAlloc.ceiling : null;
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
  const spendable = engine === 'gateway' ? gwTotal : walletOnChain;
  /**
   * The most that balance can send, fee included.
   *
   * On Gateway this is not the balance and not the balance less one fee: every
   * chain the split touches pays its own base fee and the transfer pays one
   * forwarding fee, all at the ceiling that gets signed rather than at what is
   * charged. Held back any less generously and Max fills in the one amount the
   * next check refuses, which reads as the app disagreeing with itself over
   * money. Null while the forwarding fee is unknown, which disables the
   * percentage chips rather than letting them offer a figure.
   */
  const maxSpendable =
    engine === 'gateway'
      ? gwForwarding == null || gatewayBal.value == null
        ? null
        : maxDeliverable({ balances: gwBalances, forwarding: gwForwarding })
      : walletOnChain;

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

  const fromLabel = labelFor(from);
  const toLabel = labelFor(to);


  /** A fee larger than the transfer is not a rounding detail, it is the reason to
   *  pick another route or to send more at once. */
  const feeSteep =
    amountValue > 0 && gwCeiling != null && gwCeiling > BigInt(Math.round(amountValue * 1e6));

  /**
   * Why this cannot be sent, worked out while the amount is being typed.
   *
   * Asked here rather than inside submit, because a refusal that arrives after the
   * wallet has been opened has already cost the user something. The rule itself is
   * in the SDK and tested there, so this and the check that runs at burn time
   * cannot drift into disagreeing.
   */
  const refusal =
    amountValue <= 0
      ? null
      : engine === 'gateway'
        ? gwAlloc == null || gwTotal == null || gwForwarding == null
          ? null
          : gatewayShortfall({
              shortfall: gwAlloc.shortfall,
              total: gwTotal,
              amount: gwAmount,
              deliverable: maxDeliverable({ balances: gwBalances, forwarding: gwForwarding }),
            })
        : // CCTP: guard the source USDC balance up front, the same way Gateway does,
          // so an amount over the balance disables the button instead of only failing
          // at burn time (the whole reason this refusal is computed while typing). Gas
          // is re-checked at burn time by the SDK; here the money itself is the guard.
          walletOnChain == null
          ? null
          : cctpShortfall({
              usdcBalance: walletOnChain,
              total: BigInt(Math.round(amountValue * 1e6)),
              maxFee: 0n,
              gasCost: 0n,
              nativeBalance: 2n ** 255n,
              chainLabel: fromLabel,
              gasInUsdc: false,
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
    if (fix.kind === 'useMax') setAmount(fix.display);
    else setDepositAmount(fix.display);
  }

  /**
   * Gateway serves fewer chains than CCTP, and the pickers used to be snapped back
   * by hand here whenever the engine changed.
   *
   * Nothing to do now. Both ends derive from the engine's own list: the source
   * binding re-answers when that list changes, invalidating what it read for the
   * chain being left, and the destination rule does the same. The snapping code
   * that used to live here is the thing that forgot one of the two.
   */
  const changeEngine = (e: BridgeEngine) => setEngine(e);

  /**
   * What a spend of this size would cost, and what is still uncredited.
   *
   * The balance itself is the shared store's job (`gatewayBal`); this asks Circle
   * only for the fee, which is per-route and does not belong in the shared balance.
   * The fee turns out to be flat, but it is asked for rather than assumed: a
   * hardcoded fee that drifts becomes an intent Circle rejects. `gwPending` is what
   * this browser has deposited that Circle has not yet counted, for the note under
   * the box; the crediting itself is `useSettleDeposits`, app-level.
   */
  useEffect(() => {
    if (engine !== 'gateway' || !gwSource || !isGatewayChain(to)) return;
    let live = true;
    const read = async () => {
      setGwPending(pendingOn(gwSource));
      try {
        const quote = await quoteGatewaySpend({
          from: gwSource,
          to: to as GatewayChain,
          amount: 1_000_000n,
          depositor: session.address,
        });
        // Only the forwarding fee is kept. It belongs to the destination and is
        // the same from every source, so a nominal one-chain quote is enough to
        // read it; everything else is per-leg arithmetic the allocator does.
        if (live) setGwForwarding(quote.forwarding);
      } catch {
        // Leave the last known fee rather than blanking on one failed poll; the
        // button checks again before it acts.
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
    // gwOnSource is derived from the shared store now, so it follows the source
    // change on its own; only the wallet read and deposit note reset here. The
    // forwarding fee belongs to the destination and does not move with the
    // source, so it deliberately stays.
    setGwPending(0n);
    setDepositAmount('');
  }

  /**
   * The source chain, from whichever picker asked: the From card, the funding box,
   * or the fix button under a refusal. All three go through the binding, so all
   * three also take the wallet with them.
   */
  function selectSource(chain: CctpChainName) {
    source.select(chain);
  }

  /** The destination. Cheaper to invalidate: only the quote depends on it, but it
   *  does depend on it, and a fee quoted for the previous destination is wrong. */
  /**
   * The destination.
   *
   * Everything priced against the old one is wrong now, and not by a rounding
   * margin: forwarding is destination-driven, about 0.016 into Arc against 0.054
   * into Avalanche. So the fee is dropped and re-read, which recomputes the split
   * with it. A pinned set of sources goes too: agreeing to pay for a chain was
   * agreeing at the old price.
   *
   * What does NOT change is the amount. Quietly reducing what someone typed
   * because they switched networks is how people send the wrong figure.
   */
  function selectDest(chain: CctpChainName) {
    if (chain === to) return;
    setToChoice(chain);
    setGwForwarding(null);
    /*
     * The source cards stay. They are amounts somebody typed, and a destination
     * that costs more to reach is not a reason to quietly rewrite them -- that is
     * how people send a figure they did not choose. What the new fee does change
     * is whether those amounts still fit, and the plus below them says so.
     */
  }

  function swapRoute() {
    /*
     * On Gateway the source is the one row in the list, not `from` -- `from` only
     * says which chain the deposit box is aimed at. Swapping has to move the row,
     * or the arrow reverses a route the spend is not using.
     *
     * Only offered on one row; with several there is no single end for the
     * destination to trade places with, and the marker below is inert.
     */
    if (engine === 'gateway') {
      const only = gwSources.length === 1 ? gwSources[0] : undefined;
      if (!only || !isGatewayChain(to) || only.chain === to) return;
      const dest = to as GatewayChain;
      setGwSources([{ chain: dest, amount: '' }]);
      setToChoice(only.chain);
      // Keeps the deposit box pointed at the chain that now pays.
      selectSource(dest);
      return;
    }
    if (from === to) return;
    // The old source becomes an explicit destination, so the default rule stops
    // answering for it -- the user has now said where this ends.
    setToChoice(from);
    selectSource(to);
  }

  const activeSteps = stepsForEngine(engine);
  const stepLabel = (name: string) =>
    t(
      (engine === 'gateway'
        ? `bridge.gwstep.${name}`
        : `bridge.step.${name}`) as 'bridge.step.mint',
    );

  /**
   * The line for a step the runner named, rather than for a row number.
   *
   * What this replaces ended in `?? 'mint'`, so a name that matched nothing in the
   * engine's list was announced as a mint. With the receipt now filtered to its own
   * engine that should not arise, and if it ever does the honest answer is the name
   * itself, not the most consequential step on the screen.
   */
  const reportedLabel = (name: string) => {
    const at = stepIndexFor(name, activeSteps);
    return at >= 0 ? stepLabel(activeSteps[at] as string) : name;
  };

  /**
   * Everything on this screen that describes a transfer, filtered to the engine the
   * screen is showing.
   *
   * The two tabs used to share one set of these. Since CCTP and Gateway both end on
   * a step called `mint`, a finished CCTP transfer put a green tick on the Gateway
   * stepper's last row: a mint that this engine had not performed, sitting under
   * three rows that correctly said nothing had started. Switching tabs is not a
   * transfer, so it should not be able to report one.
   */
  const shownResult = ownedBy(engine, result);

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
  const { boxes: myBoxes, names: boxNames } = knownBoxes(session.address, session.chainId);

  /** The five rows at the top of the block, unfiltered: recent means recent. */
  const activityItems = useMemo(
    () => activity.map((b) => toActivityItem(b, t as never)),
    [activity, t],
  );

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
   * Finish transfers that were interrupted between the burn and the mint.
   *
   * Nothing on a server is watching this transfer, so closing the tab during the
   * wait used to leave a row saying "pending" with no way past it -- even though
   * the money had arrived. Nothing needs to be re-signed or re-sent to find out: the
   * burn hash is enough to ask Circle where it went, so every pending burn is asked
   * again on load and every half minute after.
   *
   * Recovery, not retry. It never touches the wallet and never moves funds.
   */
  useEffect(() => {
    let live = true;
    const resume = async () => {
      for (const b of loadBridges().filter(
        (x) => x.state === 'pending' || x.state === 'returning',
      )) {
        if ((b.engine ?? 'cctp') === 'gateway') {
          /**
           * A row already known to have failed is not asked about again.
           *
           * Circle's status for it is `failed` and stays `failed`, so polling it
           * a second time can only ever say the same thing. What is still open is
           * whether the hold has been let go of, and that question is answered by
           * the balance rather than by the transfer.
           */
          if (b.state === 'returning') {
            if (b.returnBaseline == null) continue;
            const bal = await gatewayBalance({ depositor: session.address }).catch(() => null);
            const back = bal?.byChain[b.from as GatewayChain];
            if (!live || back == null) continue;
            /**
             * Back to what it was before the spend, not up by the amount.
             *
             * The baseline is the pre-spend figure, so the release restores it
             * exactly; asking for baseline plus the amount would be asking for the
             * money twice. A later deposit can also carry the balance past this
             * and read as the release, which is the same ambiguity `reconcile`
             * lives with for deposits: Circle reports a total, not a ledger.
             */
            if (back >= BigInt(b.returnBaseline)) {
              saveBridge({ ...b, state: 'returned' });
              setBridges(loadBridges());
              toast.push(t('bridge.returnedToast').replace('{amount}', b.amount), 'success');
            }
            continue;
          }

          // Gateway's receipt is the transferId, and Circle answers on it forever.
          const status = await findGatewayMint({ transferId: b.id });
          if (!live || status.state === 'pending') continue;

          if (status.state === 'done') {
            saveBridge({
              ...b,
              state: 'success',
              steps: status.mintTxHash
                ? [
                    ...b.steps.filter((s) => s.name !== 'mint'),
                    stepRow('mint', status.mintTxHash, b.to as CctpChainName),
                  ]
                : b.steps,
            });
            setBridges(loadBridges());
            toast.push(t('bridge.recovered').replace('{amount}', b.amount), 'success');
            continue;
          }

          /**
           * The mint failed, so the source burn never ran.
           *
           * Nothing was spent on chain: Circle debits its own ledger when it
           * accepts the intent and burns at settlement, which this transfer never
           * reached. What left the balance is a hold, and it comes back. Marking
           * this `error` would say the opposite of what is true, so the balance
           * now is written down as the figure to watch for.
           */
          saveBridge({
            ...b,
            state: 'returning',
            ...(status.reason ? { failureReason: status.reason } : {}),
          });
          setBridges(loadBridges());
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
          // Replace rather than append: a row saved while the mint was still out
          // already carries the attestation step, and appending a second one put
          // the same line in the record twice.
          steps: [
            ...b.steps.filter((s) => s.name !== 'fetchAttestation' && s.name !== 'mint'),
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
  }, [t, toast, session.address]);

  /**
   * Both engines go through the connected wallet.
   *
   * CCTP burns the user's own USDC and Circle mints it back to them; a Gateway
   * spend is an EIP-712 signature over an intent Circle settles. Neither needs a
   * server key, so there is none in this file and no operator balance behind it.
   * Gateway used to run on the server because its kit is Node-first, which is why
   * `packages/sdk/src/bridge/gateway.ts` speaks to the contracts and the REST API
   * directly instead.
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
    const on = gwSource;
    /*
     * What Circle reports for this chain right now, before any of this happens, so
     * the wait afterwards has an absolute figure to watch for rather than a rise it
     * has to be looking at the exact moment it happens. Read here rather than after
     * the transaction, because after it the reading may already include the credit.
     *
     * Null when the balance has not been read at all, which is not zero: recording
     * zero would set a target this deposit could reach without having been counted.
     */
    const before = gatewayBal.value ? (gwByChain[on] ?? 0n) : undefined;
    const record = startRun({
      kind: 'deposit',
      engine: 'gateway',
      from: on,
      to: on,
      amount: depositAmount,
    });
    record.begin('approve');
    setSpotlight(record.id);
    let reached = 'approve';
    try {
      await depositToGateway(bridgeClients(CCTP_CHAINS[on].chainId, session.address), {
        chain: on,
        amount: depositValue,
        /*
         * The deposit's own steps, not the transfer map above.
         *
         * That map answers for a spend, whose rows are deposit, sign, attestation
         * and mint, and it folded `approve` into `deposit` because a deposit had
         * only the one row to fold it into. Both of those things now have a row of
         * their own, and an approval the user was prompted for is not the deposit
         * they were prompted for next.
         */
        onStep: (step, txHash) => {
          if (step !== 'approve' && step !== 'deposit') return;
          // No hash on `approve` is the SDK saying the allowance already covered
          // this, which is a step that did not need to happen.
          if (step === 'approve' && !txHash) record.skip('approve');
          else record.done(step, txHash);
          if (step === 'approve') {
            record.begin('deposit');
            reached = 'deposit';
          }
        },
      });
      // Mined, and not yet spendable. Circle credits it after the source chain's
      // confirmations, and that wait is the run's last step rather than its end.
      record.begin('counted');
      record.waiting();
      rememberDeposit(on, depositValue, before);
      setGwPending(pendingOn(on));
      setDepositAmount('');
      toast.push(
        t('bridge.deposited').replace('{amount}', depositAmount).replace('{wait}', waitLabel(on)),
        'success',
      );
    } catch (e) {
      // Both are told which prompt it was. A deposit asks for an approval and
      // then for the deposit itself, and "you cancelled it" is ambiguous for
      // exactly as long as it takes to wonder which of the two was cancelled.
      record.fail(reached, e);
      toast.fail(e, { step: `bridge.rowstep.${reached}` });
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
    // Clear this engine's last receipt, not the other engine's. Wiping both meant
    // a Gateway transfer erased the CCTP receipt sitting on the tab next door.
    setResult((prev) => (prev && prev.engine !== engine ? prev : null));
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
      /*
       * The split is decided here, once, from the same allocation the source line
       * has been showing. Re-deriving it inside the spend would let the button do
       * something the screen never said, which is the one thing a receipt line
       * exists to rule out.
       */
      if (!gwAlloc || gwAlloc.legs.length === 0) {
        toast.push(t('bridge.gwChainMissing'), 'error');
        dispatch.release();
        return;
      }
      const sources = gwAlloc.legs.map((l) => ({ chain: l.chain, value: l.value }));
      /**
       * A spend does not fund anything.
       *
       * The whole point of Gateway is that the balance was deposited earlier, by
       * the box above, possibly minutes ago. The spend reports quote, sign,
       * transfer and mint, and never a deposit -- yet the stepper's first row said
       * "Funding unified balance" and the completion handler wrote that row down as
       * having happened, so a green tick appeared over a deposit this transfer had
       * not made. The row stays, because it is how the model works; what changes is
       * that it says so. A run that does report a deposit overwrites this.
       */
      // What the runner has reported, in order, so the row written while Circle
      // still has the intent carries the steps that actually happened.
      const reported: StoredBridgeStep[] = [];
      /**
       * The row exists before the signature is asked for.
       *
       * It used to be written in `onTransferId`, which is after the wallet prompt
       * and after Circle has accepted the intent -- so pressing Bridge, signing,
       * and then watching nothing appear anywhere was the normal experience, and
       * the row turned up at the end looking like a receipt rather than like
       * something that had been happening. CCTP fixed exactly this for itself and
       * says so in its own comment; the Gateway path never got the same treatment.
       *
       * The id is invented here because Circle has not been asked yet. When it
       * answers, the row takes the transferId as its name (see `rekey`), which is
       * what the mint is looked up by afterwards.
       */
      const record = startRun({
        engine: 'gateway',
        from,
        to,
        amount,
        ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() } : {}),
      });
      setSpotlight(record.id);
      record.begin('sign');
      try {
        // No wallet client bound to a chain: a spend is a signature, so it works
        // wherever the wallet happens to be.
        const res = await spendFromGateway(
          { walletClient: session.clients.walletClient },
          {
            sources,
            to: to as GatewayChain,
            ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() as Address } : {}),
            onStep: (step, txHash) => {
              const name = GW_STEP_TO_UI[step];
              if (!name) return;
              reported.push(routedStep(name, txHash, { engine: 'gateway', from, to }));
              // Onto the row as well as into the list, so what is on screen moves
              // while the transfer does rather than all at once at the end.
              record.done(name, txHash);
              const next = activeSteps[stepIndexFor(name, activeSteps) + 1];
              if (next) record.begin(next);
            },
            // Write the receipt down the moment Circle accepts the intent, not when
            // the mint lands. The wait in between is where a tab gets closed, and
            // without this the transferId would be gone with it.
            onTransferId: (transferId) => {
              dispatch.release();
              /*
               * The row takes the name Circle gave it, keeping the steps it has
               * already collected. It is the same row the user has been watching
               * since the button was pressed, not a second one appearing beside it.
               */
              record.rekey(transferId);
              record.amend({
                fromLabel,
                toLabel,
                state: 'pending',
                /**
                 * What the balance was before this spend, written now because now
                 * is the only time it is knowable.
                 *
                 * If the mint fails, the debit is a hold that Circle releases and
                 * the balance returns to exactly this figure. Reading a baseline
                 * at failure time instead does not work, and not subtly: measured
                 * on this route the release landed inside sixteen minutes, sooner
                 * than the failure was noticed, so the "baseline" was already the
                 * released figure and the row could never reach it. It sat on
                 * `returning` for good.
                 */
                /*
                 * Across every chain, not the source chain. A spend can draw on
                 * several at once, so a baseline taken from one of them would sit
                 * below the released figure for good and the row would never
                 * reach it.
                 */
                ...(gwTotal != null ? { returnBaseline: gwTotal.toString() } : {}),
                // The same figure the card above this form calls the fee: the
                // ceiling that was signed, not a quote that can drift from it.
                ...(gwCeiling != null ? { fee: usdc(gwCeiling) } : {}),
              });
              setSpotlight(transferId);
              setBridges(loadBridges());
            },
          },
        );
        // What was done, for the record.
        const steps = [
          ...reported.filter((x) => x.name !== 'mint'),
          ...(res.mintTxHash ? [stepRow('mint', res.mintTxHash, to)] : []),
        ];
        // `pending`, not `running`: Circle has the intent and the mint has not
        // landed. `pending` is the word the stored row already uses for that
        // moment, and the block reads it as still moving.
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
          ...(gwCeiling != null ? { fee: usdc(gwCeiling) } : {}),
          createdAt: Date.now(),
        });
        setBridges(loadBridges());
        // The spend moved money out of Gateway: refresh every screen watching it.
        bumpBalances();
        toast.push(
          res.mintTxHash ? t('bridge.done') : t('bridge.forwardPending'),
          res.mintTxHash ? 'success' : 'info',
        );
      } catch (e) {
        /*
         * The row says what happened to it, rather than vanishing.
         *
         * Before there was a row to fail, a declined signature left nothing at
         * all behind: a toast that scrolls away, and a Recent list with no trace
         * of the transfer that had just been attempted. The step named is the one
         * the run had reached, so "you declined the signature" and "Circle refused
         * the intent" are not the same line.
         */
        record.fail(reported.length > 0 ? 'attestation' : 'sign', e);
        setBridges(loadBridges());
        toast.fail(e);
      } finally {
        dispatch.release();
      }
      return;
    }

    // What the runner has told us so far, in the order it arrived, so a record
    // written mid-transfer carries the same steps the screen is showing.
    const reported: StoredBridgeStep[] = [];
    /** Circle's figure for this transfer, known before the burn and written with it. */
    let quotedFee: string | undefined;
    /*
     * The row exists before the wallet prompt does.
     *
     * It used to be written when the burn confirmed, which is ten to twenty seconds
     * after the button is pressed and two signatures later. With the stepper gone
     * from this form, that was ten to twenty seconds in which a transfer had been
     * started and nothing anywhere said so. The id is generated rather than taken
     * from the burn, because there is no burn yet; the burn hash lives in the steps,
     * which is where the recovery pass reads it from anyway.
     */
    const record = startRun({
      engine: 'cctp',
      from,
      to,
      amount,
      ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() } : {}),
    });
    setSpotlight(record.id);
    record.begin('approve');
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
          onQuote: (q) => {
            quotedFee = usdc(q.maxFee);
          },
          onStep: (step, txHash) => {
            const name = SDK_STEP_TO_UI[step];
            if (!name) return; // quoting is instant; it has no row of its own
            reported.push(routedStep(name, txHash, { engine: 'cctp', from, to }));
            /*
             * The approval, written down the moment it lands.
             *
             * The row is not rewritten until the burn confirms, so an approval
             * that was mined and then followed by a declined burn left the row
             * showing an approval with no transaction on it -- the one step the
             * person had already paid gas for. No hash means the SDK found the
             * allowance already sufficient, which is a step that did not happen.
             */
            if (name === 'approve') {
              if (txHash) record.done('approve', txHash);
              else record.skip('approve');
              record.begin('burn');
            }
            // Write the burn down the moment it confirms, not when the whole
            // transfer resolves. The wait for Circle is the long part and a reload
            // during it would otherwise lose the one hash the money can be traced
            // and recovered from. `pending` is honest: burned, not yet minted.
            if (step === 'burn' && txHash) {
              dispatch.release();
              saveBridge({
                id: record.id,
                engine: 'cctp',
                from,
                to,
                fromLabel,
                toLabel,
                amount,
                ...(isAddress(recipient.trim()) ? { recipient: recipient.trim() } : {}),
                state: 'pending',
                /*
                 * Everything reported so far, not the burn alone.
                 *
                 * This row used to carry only the burn, so for the whole minute
                 * Circle takes it showed the approval greyed out beside it -- the
                 * same grey as a step that has not happened. The approval had
                 * happened, or had not been needed, and either way the row was
                 * saying otherwise about the one part of a transfer a person is
                 * asked to sign.
                 */
                steps: [
                  ...(reported.some((x) => x.name === 'approve')
                    ? []
                    : // Nothing reported it, which for this SDK means the allowance
                      // already covered the amount: a step that did not need to
                      // happen, drawn as a dash rather than as one still to come.
                      [{ name: 'approve', state: 'noop' as const }]),
                  ...reported,
                ],
                ...(quotedFee ? { fee: quotedFee } : {}),
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
          : // Burned, and Circle has not minted yet. The attestation row is added
            // anyway so the spinner sits on the step that is actually outstanding;
            // without it the indicator spun on "Burning on the source chain" long
            // after the burn had confirmed.
            [stepRow('fetchAttestation')]),
      ];
      saveBridge({
        id: record.id,
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
        fee: usdc(res.quote.maxFee),
        createdAt: Date.now(),
      });
      setBridges(loadBridges());
      toast.push(
        res.forwardTxHash ? t('bridge.done') : t('bridge.forwardPending'),
        res.forwardTxHash ? 'success' : 'info',
      );
    } catch (e) {
      /*
       * The step it died on: the first one that never reported.
       *
       * The SDK reports a step when it finishes, so the last name in `reported`
       * is the last thing that worked, not the thing that broke. Blaming it put
       * the failure one step early: declining the burn marked the approval as
       * failed, in a run where the approval was already mined and on chain, and
       * the toast said so out loud. An allowance that already covered the amount
       * still reports `approve`, so a skipped step does not shift this either.
       */
      const done = new Set(reported.map((s) => s.name));
      const names = stepsForEngine('cctp');
      const last = names.find((name) => !done.has(name)) ?? names[names.length - 1] ?? 'approve';
      record.fail(last, e);
      setBridges(loadBridges());
      toast.fail(e, { step: `bridge.rowstep.${last}` });
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
      <Card data-testid="bridge-tab">
        <div className="bridge-engine">
          <SegmentedTabs
            tabs={[
              {
                id: 'cctp',
                label: t('bridge.engine.cctp'),
                infoAria: t('bridge.info.aria'),
                info: (
                  <InfoBody
                    lead={t('bridge.info.cctpBody')}
                    points={[
                      t('bridge.cctp.point1'),
                      t('bridge.cctp.point2'),
                      t('bridge.cctp.point3'),
                    ]}
                  />
                ),
              },
              {
                id: 'gateway',
                label: t('bridge.engine.gateway'),
                infoAria: t('bridge.info.aria'),
                info: (
                  <InfoBody
                    lead={t('bridge.info.gatewayBody')}
                    points={[
                      t('bridge.gateway.point1'),
                      t('bridge.gateway.point2'),
                      t('bridge.gateway.point3'),
                    ]}
                  />
                ),
              },
            ]}
            value={engine}
            onChange={changeEngine}
          />
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
          <Card title={t('bridge.fundForBridgeTitle')} className="card--fund" data-testid="bridge-fund">
          <GatewayFundBox
            chain={from}
            balances={gwByChain}
            onChainChange={(v) => selectSource(v as CctpChainName)}
            balance={gwOnSource}
            maxDeposit={maxDeposit}
            amount={depositAmount}
            onAmountChange={setDepositAmount}
            walletOnChain={walletOnDepositChain}
            pending={gwPending}
            wait={t('bridge.gwDepositWait', { chain: fromLabel, wait: waitLabel(gwSource) })}
            format={usdc}
            busy={depositing || switching || source.switching}
            onDeposit={() =>
              void (async () => {
                // Being on the wrong network is a step, not a refusal: move the
                // wallet, then deposit, rather than sending the user to find the
                // network switcher and come back.
                if (!walletOnDepositChain && gwSource) {
                  setSwitching(true);
                  try {
                    await switchWalletTo(CCTP_CHAINS[gwSource].chainId, fromLabel);
                  } catch (e) {
                    toast.fail(e);
                    return;
                  } finally {
                    setSwitching(false);
                  }
                }
                await guard(deposit);
              })()
            }
          />
          </Card>
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
          {/*
            One From either way. What differs is what is inside it.

            CCTP burns the wallet's own USDC on one named chain, so the card holds
            a chain picker and an amount. A Gateway spend draws on a balance spread
            over several chains under a single signature, so the same card holds
            the amount and, under it, the networks carrying it. One block, one
            amount, one label saying From, whichever engine is on.
          */}
          {engine === 'gateway' ? (
            <GatewaySources
              amount={amount}
              onAmount={setAmount}
              sources={gwSources}
              onSources={setGwSources}
              balances={gwBalances}
              forwarding={gwForwarding ?? 0n}
              loaded={gatewayBal.value != null && gwForwarding != null}
              onDeposit={(need) => setDepositAmount(usdc(need))}
            />
          ) : (
            <div className="swapcard" data-testid="bridge-from-card">
              <div className="swapcard__head">
                <span className="swapcard__label">{t('bridge.from')}</span>
                <ChainSelect
                  purpose="cctpSource"
                  value={from}
                  onChange={selectSource}
                  ariaLabel={t('bridge.from')}
                />
              </div>
              <AmountField
                value={amount}
                onChange={setAmount}
                chain={from}
                balance={spendable}
                balanceMissing={!walletRead || walletOnChain !== null ? 'loading' : 'unavailable'}
                balanceLabel={t('bridge.balance')}
                onMax={fillPercent}
                percents={[0.25, 0.5]}
                data-testid="bridge-amount"
              />
            </div>
          )}

          {/* In the gap between the cards, painted in the page background so it
              reads as a cut-out rather than a third element.

              Always present, because it is what holds the two cards apart and
              says which way the money goes; dropping it on Gateway left them
              meeting on a shared edge, reading as one panel with a seam.

              What it does depends on whether there are two ends to swap. One
              source and it trades places with the destination. Several, and there
              is no single end the destination could change places with, so the
              same shape stays as a direction marker and stops being a button
              rather than becoming a button that does nothing. */}
          {engine !== 'gateway' || gwSources.length === 1 ? (
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
          ) : (
            <div className="swapstack__flip swapstack__flip--static" aria-hidden>
              <span>&darr;</span>
            </div>
          )}

          <div className="swapcard" data-testid="bridge-to-card">
            <div className="swapcard__head">
              <span className="swapcard__label">{t('bridge.to')}</span>
              {/* The destination's list is the engine's, and it is a different
                  question from the source's: Gateway mints on eleven chains and
                  CCTP on twenty, and nothing is signed at this end either way. */}
              <ChainSelect
                purpose={engine === 'gateway' ? 'gatewayDestination' : 'cctpDestination'}
                value={to}
                onChange={selectDest}
                ariaLabel={t('bridge.to')}
              />
            </div>
            {/* What arrives, not a second thing to fill in. Gateway takes its fee
                out of the balance rather than out of the transfer, and CCTP's comes
                off the sender's side too, so the figure is the same one. */}
            <AmountField
              /*
               * What actually arrives, which is not always what the cards add up
               * to. A card may hold more than its chain can pay -- people type the
               * figure they have in mind -- and summing those gave this, the
               * largest number on the screen, a value nobody was ever going to
               * receive: 124.001142 out of chains holding 4.76 between them.
               *
               * So the shortfall comes off. The cards still show what was asked
               * for, each over-reaching one says what its chain can really do, and
               * this says what lands at the other end.
               */
              value={engine === 'gateway' ? usdc(gwDeliverable) : amount}
              onChange={() => {}}
              readOnly
              chain={to}
              balance={toBalance}
              // Null here is "cannot be read from this chain" (see readUsdcOn), not
              // "still arriving", so the slot holds still rather than shimmering
              // for a number that is never coming.
              balanceMissing="unavailable"
              balanceLabel={t('bridge.balance')}
              label={t('bridge.youReceive')}
              data-testid="bridge-receive"
            />
          </div>
        </div>

        {/* All three were bare paragraphs under the cards: a red line, a grey line
            and another grey line, at three weights, none of them looking like the
            screen addressing the reader. Same container, tone carrying the
            difference. */}
        {sameChain && !gwWithdraw && (
          <Notice tone="warn" testId="bridge-samechain">
            {t('bridge.sameChain')}
          </Notice>
        )}
        {/* Same chain in and out needs no sentence. The primary button already
            reads "Withdraw to my wallet" instead of "Bridge", which is the loudest
            control on the screen, and the cost block underneath gives the actual
            fee rather than a comparison to a transfer nobody is making. What was
            here restated both: the action in words next to the button that
            performs it, and the price as a fraction of a different price. */}
        {/* Whose money moves is the thing that changed, so say it plainly rather
            than leaving the user to infer it from a MetaMask prompt. */}
        {engine === 'cctp' && !walletOnSource && (
          <Notice tone="info" testId="bridge-selfnote">
            {t('bridge.wrongSourceChain').replace('{chain}', fromLabel)}
          </Notice>
        )}

        {/*
          What this costs, before it is agreed to.
          The fee is not small and it depends on the route rather than the amount:
          the same transfer costs 0.055 to Base and sixteen times that to Ethereum
          Sepolia, because it pays for gas on the destination. Learning that from
          the balance afterwards is not an acceptable way to learn it.
        */}
        {/*
          The fee here and the fee on the source line above are the same number,
          and it is what Circle charges: the base fee of every chain the split
          touches, plus one forwarding fee. Measured, and reported by Circle
          itself as `fees.total`.

          It is not the ceiling. The signature authorises close to twice this, so
          that a doubling of gas between quoting and settling still goes through,
          and Circle then takes what the transfer cost and ignores the rest. That
          headroom is the app's problem and it is what the balance is checked
          against; it is not what leaves the account, so it is not what the
          account holder is told. Two numbers one line apart, only one of which
          they are ever charged, is how a screen loses somebody's trust in its
          arithmetic.
        */}
        {gwCeiling != null && (
          <CostBlock
            testId="bridge-fee-card"
            lines={[
              {
                label: t('cost.circleFee'),
                value: `${usdc(gwAlloc?.fee ?? 0n)} USDC`,
                testId: 'bridge-fee',
                /*
                 * The same total, in the pieces it is made of: one base fee per
                 * network the split touches, plus the forwarding fee the
                 * destination charges. Those pieces differ by a factor of a
                 * thousand -- Ethereum is 1.00 a leg and Unichain 0.001 -- so a
                 * split that suddenly costs a USDC has, on one line, no way of
                 * saying which network made it cost that.
                 *
                 * Built from the allocation rather than beside it, so it cannot
                 * add up to a different number than the line it unfolds from.
                 */
                breakdown: gatewayFeeLines(gwAlloc, gwForwarding ?? 0n).map((part) => ({
                  label: part.chain ? (
                    <>
                      <ChainLogo id={part.chain} size={16} />
                      <span>{labelFor(part.chain)}</span>
                    </>
                  ) : (
                    <span>{t('cost.forwarding', { chain: toLabel })}</span>
                  ),
                  value: `${usdc(part.fee)} USDC`,
                  testId: part.chain ? `bridge-fee-${part.chain}` : 'bridge-fee-forwarding',
                })),
              },
            ]}
            // Only once there is an amount to total up. The quote is asked for with
            // a nominal amount before anything is typed, so that Max can leave room
            // for the fee; printing a total here would tell someone what they are
            // about to pay for a transfer they have not entered.
            total={
              amountValue > 0 && gwAlloc && gwAlloc.legs.length > 0
                ? {
                    label: t('cost.youPay'),
                    value: `${usdc(gwAmount + gwAlloc.fee)} USDC`,
                    testId: 'bridge-youpay',
                  }
                : null
            }
            warning={feeSteep ? t('bridge.feeOverAmount') : null}
          />
        )}

        {/*
          One line, and the button that fixes it. Naming the problem and leaving
          the user to find the chain picker is most of the way to not saying it.

          CCTP only. On Gateway the plus between the cards already says what is
          missing and offers the chain that would cover it, so this printed the
          same figure again a few pixels lower -- in red, under an offer that was
          not an alarm. Two voices for one fact, and the louder one was the less
          useful.
        */}
        {engine !== 'gateway' && refusal && (
          <div className="refusal" data-testid="bridge-refusal">
            <p className="refusal__msg">
              {t(`bridge.refusal.${refusal.code}` as never, refusal.params)}
            </p>
            {refusal.fix && (
              <Button variant="ghost" onClick={applyFix} data-testid="bridge-refusal-fix">
                {refusal.fix.kind === 'deposit'
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
              onClear={() => setRecipient('')}
              placeholder={t('bridge.recipientPlaceholder')}
              data-testid="bridge-recipient"
            />
          </Field>
        </div>

        {/* Same firewall as the send screen, same verdict, same block, and now
            the same reasons: this used to render the rule card only, so a bridge
            could refuse on an advisory the user was never shown. */}
        <RiskGate gate={risk} recoverable={false} data-testid="bridge-risk" />

        {/*
          No stepper here any more.

          It drew four rows inside the form, above the button that made them, and
          it held one run: a second transfer had nowhere to go while the first was
          still waiting on Circle, which on this screen is most of a minute. The
          same slot problem the deposit had, in the place where somebody is most
          likely to want to start another one.

          Progress is a row in the block at the bottom now, where two of them are
          two rows. What replaces the stepper is being taken there: the run lights
          up when it appears, or raises the pill when the block is out of view.
        */}

        <div style={{ marginTop: 16 }}>
          {/* Being on the wrong network is a step, not a failure. Offering the
              switch is one click; a disabled button is a dead end. */}
          {!walletOnSource && cctpSource ? (
            <Button
              full
              disabled={switching || source.switching}
              data-testid="bridge-switch"
              onClick={() =>
                void (async () => {
                  setSwitching(true);
                  try {
                    await switchWalletTo(cctpSource.chainId, fromLabel);
                  } catch (e) {
                    toast.fail(e);
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
              {gwWithdraw ? t('bridge.withdrawButton') : t('bridge.button')}
            </Button>
          )}
        </div>
        {!bridgeEnabled && <p className="hint">{t('bridge.noKey')}</p>}

        {/* A bridge can come back 200 and still have failed at a step. Rendering only
            the success case left the screen unchanged, which reads as "the button
            does nothing" rather than "CCTP refused this amount". */}
        {shownResult && shownResult.state !== 'success' && (
          <div className="risk risk--block" style={{ marginTop: 14 }} data-testid="bridge-error">
            <div className="risk__head">{t('bridge.failed')}</div>
            <ul className="risk__reasons">
              {shownResult.steps
                .filter((s) => s.state !== 'success')
                .map((s) => (
                  <li key={s.name} className="risk__reason risk__reason--block">
                    {reportedLabel(s.name)}
                    {s.error ? `: ${s.error}` : ''}
                  </li>
                ))}
            </ul>
          </div>
        )}

        {shownResult?.state === 'success' && (
          <div className="row wrap" style={{ marginTop: 14 }} data-testid="bridge-success">
            {shownResult.steps
              .filter((s) => s.txHash && safeHttpUrl(s.explorerUrl))
              .map((s) => (
                <TxLink
                  key={s.name}
                  href={safeHttpUrl(s.explorerUrl)}
                  label={s.name}
                  copyValue={s.txHash ?? ''}
                  title={reportedLabel(s.name)}
                />
              ))}
          </div>
        )}
      </Card>

      {/*
        The same block that sits at the bottom of the subscriptions screen, over the
        same records: the last few things this wallet did, with whatever is still
        going at the top of them, and the full searchable history behind `All`.

        The list underneath is unchanged. It is the ledger -- fifty rows, filtered,
        paged, split by whether a transfer paid for a subscription -- and it is a
        bad answer to "is the thing I just did alright", which is the question the
        five rows above it exist for.
      */}
      <div style={{ marginTop: 16 }}>
        <ActivityBlock
          items={activityItems}
          labels={activityLabels(t as never, t('activity.title'))}
          spotlight={spotlight}
          data-testid="bridge-activity"
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
            reserveId="bridge-history"
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
                    /* `returning` reads as in-flight rather than as a failure,
                       because that is what it is: the mint did not happen and the
                       money is on its way back. A red cross next to an amount that
                       is coming back is the one thing this row must not say. */
                    tone:
                      b.state === 'success' || b.state === 'returned'
                        ? 'ok'
                        : b.state === 'error'
                          ? 'err'
                          : 'idle',
                    label: t(`bridge.state.${b.state}` as 'bridge.state.success'),
                  }}
                  time={relativeTime(b.createdAt)}
                />
                {/* One line, and only what is known. Why the mint failed is true
                    for this transfer and not for every ON_CHAIN_FAILURE, so the
                    row says what happened and Circle's own words go in the facts
                    below rather than being turned into an explanation. */}
                {(b.state === 'returning' || b.state === 'returned') && (
                  <p className="hrow__note" data-testid="bridge-return-note">
                    {t(b.state === 'returning' ? 'bridge.returnNote' : 'bridge.returnedNote')}
                  </p>
                )}
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
                    {failureNote(b, t as never) && (
                      <HistoryRow.Fact label={t('bridge.rowReason')}>
                        <span>{failureNote(b, t as never)}</span>
                      </HistoryRow.Fact>
                    )}
                  </HistoryRow.Facts>
                )}
                <HistoryRow.Steps steps={b.steps.map((s) => rowStep(s, t))} />
              </HistoryRow>
            )}
          />
        </ActivityBlock>
      </div>
    </>
  );
}
