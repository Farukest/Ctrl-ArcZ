import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@ctrl-arcz/demo-kit';
import { parseUnits } from 'viem';
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
  type CctpChainName,
  type CctpStep,
  type GatewayChain,
  type GatewayStep,
} from '@ctrl-arcz/sdk';
import { bridgeClients, switchWalletChain } from '@ctrl-arcz/demo-kit';
import { activeJobIds, forgetJob, readBridgeJob, type BridgeJob } from '../lib/bridgeJob.js';
import {
  BRIDGE_STEPS,
  GATEWAY_STEPS,
  bridgeChainLabel,
  type BridgeChainName,
  type BridgeEngine,
  type BridgeOutcome,
} from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  ChainLogo,
  Field,
  InfoPopover,
  Input,
  PagedList,
  Pagination,
  paginate,
  SearchField,
  SegmentedTabs,
  Select,
  Stepper,
  TxLink,
  useSubmitGuard,
  useT,
  useToast,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { loadBridges, saveBridge, type StoredBridge } from '../store.js';

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
  /**
   * What this wallet can spend through Gateway right now, in USDC subunits.
   * `null` until read; a deposit that has not reached its confirmations is not here.
   */
  const [gwBalance, setGwBalance] = useState<bigint | null>(null);
  /**
   * Per chain, because that is what a transfer actually spends. Showing only the
   * total would tell someone with money on Arc that they can send from Base.
   */
  const [gwOnSource, setGwOnSource] = useState<bigint | null>(null);
  const [gwFee, setGwFee] = useState<bigint | null>(null);
  const [depositing, setDepositing] = useState(false);
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
  const [histQuery, setHistQuery] = useState('');
  const [histEngine, setHistEngine] = useState<'all' | BridgeEngine>('all');
  const [histPage, setHistPage] = useState(0);

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
  const gwNeeded = gwFee != null ? BigInt(Math.round(amountValue * 1e6)) + gwFee : null;
  // Short against the SOURCE chain, not the total: the check that matters.
  const gwShort = gwOnSource != null && gwNeeded != null && gwOnSource < gwNeeded;
  /**
   * Same chain in and out is not a mistake in Gateway, it is the way money comes
   * back. Calling it a bridge would be wrong, so the button says what it does.
   */
  const gwWithdraw = engine === 'gateway' && sameChain;
  const walletOnDepositChain = !gwSource || session.chainId === CCTP_CHAINS[gwSource].chainId;

  const running = jobs.filter((j) => j.state === 'running').length;
  const canBridge = bridgeEnabled && amountValue > 0 && (!sameChain || engine === 'gateway');

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
        setGwBalance(bal.total);
        setGwOnSource(bal.byChain[gwSource] ?? 0n);
        setGwFee(quote.maxFee);
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

  const filteredHistory = useMemo(() => {
    const q = histQuery.trim().toLowerCase();
    return bridges.filter(
      (b) =>
        (histEngine === 'all' || (b.engine ?? 'cctp') === histEngine) &&
        (!q || bridgeHaystack(b).includes(q)),
    );
  }, [bridges, histQuery, histEngine]);

  const pageCount = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE));
  const page = Math.min(histPage, pageCount - 1);
  const pageRows = paginate(filteredHistory, page, HISTORY_PAGE_SIZE);

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
          setHistPage(0);
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
  async function deposit() {
    if (!gwSource) return;
    setDepositing(true);
    setSelfBridge({ steps: [], state: 'running' });
    try {
      const res = await depositToGateway(
        bridgeClients(CCTP_CHAINS[gwSource].chainId, session.address),
        {
          chain: gwSource,
          amount: parseUnits(amount, 6),
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
      const wait = DEPOSIT_CONFIRMATION_SECONDS[gwSource];
      toast.push(
        t('bridge.deposited')
          .replace('{amount}', amount)
          .replace('{wait}', wait < 60 ? `${wait}s` : `${Math.round(wait / 60)}m`),
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

  async function run() {
    setResult(null);
    if (engine === 'gateway') {
      if (!gwSource || !isGatewayChain(to)) return;
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
              saveBridge({
                id: transferId,
                engine: 'gateway',
                from,
                to,
                fromLabel,
                toLabel,
                amount,
                state: 'pending',
                steps: [{ name: 'deposit' }, { name: 'sign' }, { name: 'attestation' }],
                createdAt: Date.now(),
              });
              setBridges(loadBridges());
              setHistPage(0);
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
          state: res.mintTxHash ? 'success' : 'pending',
          steps,
          createdAt: Date.now(),
        });
        setBridges(loadBridges());
        setHistPage(0);
        setGwBalance(null);
        setGwOnSource(null);
        toast.push(
          res.mintTxHash ? t('bridge.done') : t('bridge.forwardPending'),
          res.mintTxHash ? 'success' : 'info',
        );
      } catch (e) {
        setSelfBridge(null);
        toast.push(e instanceof Error ? e.message : String(e), 'error');
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
              saveBridge({
                id: txHash,
                engine: 'cctp',
                from,
                to,
                fromLabel,
                toLabel,
                amount,
                state: 'pending',
                steps: [stepRow('burn', txHash, from)],
                createdAt: Date.now(),
              });
              setBridges(loadBridges());
              setHistPage(0);
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
        // No forward hash yet is not a failure: the burn is permanent and Circle
        // will still mint. Recording it as pending keeps the receipt either way.
        state: res.forwardTxHash ? 'success' : 'pending',
        steps,
        createdAt: Date.now(),
      });
      setBridges(loadBridges());
      setHistPage(0);
      toast.push(
        res.forwardTxHash ? t('bridge.done') : t('bridge.forwardPending'),
        res.forwardTxHash ? 'success' : 'info',
      );
    } catch (e) {
      setSelfBridge(null);
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  return (
    <>
      <Card title={t(`bridge.${engine}.title`)} data-testid="bridge-tab">
        <p className="muted">{t(`bridge.${engine}.body`)}</p>
        <ul className="hintlist">
          <li>{t(`bridge.${engine}.point1`)}</li>
          <li>{t(`bridge.${engine}.point2`)}</li>
          <li>{t(`bridge.${engine}.point3`)}</li>
        </ul>

        <hr className="rule" />

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

        <div className="bridge-route-row" style={{ marginTop: 16 }}>
          <div className="bridge-route-col">
            <Field label={t('bridge.from')}>
              <Select
                value={from}
                options={chainOptions}
                onChange={(v) => setFrom(v as CctpChainName)}
                ariaLabel={t('bridge.from')}
                searchable
                searchPlaceholder={t('bridge.searchChain')}
                noResultsText={t('common.noResults')}
                full
              />
            </Field>
          </div>
          <span className="bridge-route-sep" aria-hidden>
            &rarr;
          </span>
          <div className="bridge-route-col">
            <Field label={t('bridge.to')}>
              <Select
                value={to}
                options={chainOptions}
                onChange={(v) => setTo(v as CctpChainName)}
                ariaLabel={t('bridge.to')}
                searchable
                searchPlaceholder={t('bridge.searchChain')}
                noResultsText={t('common.noResults')}
                full
              />
            </Field>
          </div>
        </div>
        {sameChain && !gwWithdraw && <p className="hint">{t('bridge.sameChain')}</p>}
        {gwWithdraw && <p className="hint">{t('bridge.withdrawHint')}</p>}
        {/* Whose money moves is the thing that changed, so say it plainly rather
            than leaving the user to infer it from a MetaMask prompt. */}
        {engine === 'cctp' && (
          <p className="hint" data-testid="bridge-selfnote">
            {walletOnSource
              ? t('bridge.selfFunded')
              : t('bridge.wrongSourceChain').replace('{chain}', fromLabel)}
          </p>
        )}
        {/* The balance is the whole story in Gateway, so it is stated rather than
            left for the user to discover through a refusal. */}
        {engine === 'gateway' && (
          <p className="hint" data-testid="gateway-balance">
            {gwBalance == null || gwOnSource == null
              ? t('bridge.gwBalanceLoading')
              : t('bridge.gwBalanceHere')
                  .replace('{chain}', fromLabel)
                  .replace('{here}', String(Number(gwOnSource) / 1e6))
                  .replace('{total}', String(Number(gwBalance) / 1e6)) +
                (gwBalance > gwOnSource ? ' ' + t('bridge.gwBalanceElsewhere') : '') +
                ' ' +
                t('bridge.gwBalance').replace(
                  '{fee}',
                  gwFee == null ? '?' : String(Number(gwFee) / 1e6),
                )}
            {gwSource && gwShort
              ? ' ' +
                t('bridge.gwDepositWait')
                  .replace('{chain}', fromLabel)
                  .replace(
                    '{wait}',
                    DEPOSIT_CONFIRMATION_SECONDS[gwSource] < 60
                      ? `${DEPOSIT_CONFIRMATION_SECONDS[gwSource]}s`
                      : `${Math.round(DEPOSIT_CONFIRMATION_SECONDS[gwSource] / 60)}m`,
                  )
              : ''}
          </p>
        )}

        <div style={{ marginTop: 16 }}>
          <Field label={t('bridge.amount')} hint={t('bridge.feeNote')}>
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="bridge-amount"
            />
          </Field>
        </div>

        {(result || job || selfBridge) && <Stepper steps={steps} highlightIndex={hoverIdx} />}

        <div style={{ marginTop: 16 }}>
          {/* Being on the wrong network is a step, not a failure. Offering the
              switch is one click; a disabled button is a dead end. */}
          {engine === 'gateway' && gwShort ? (
            !walletOnDepositChain && gwSource ? (
              <Button
                full
                disabled={switching}
                data-testid="bridge-switch"
                onClick={() =>
                  void (async () => {
                    setSwitching(true);
                    try {
                      await switchWalletChain(CCTP_CHAINS[gwSource].chainId, fromLabel);
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
                disabled={!canBridge || depositing}
                data-testid="gateway-deposit"
                onClick={() => void guard(deposit)}
              >
                {t('bridge.depositButton')
                  .replace('{amount}', amount)
                  .replace('{chain}', fromLabel)}
              </Button>
            )
          ) : !walletOnSource && cctpSource ? (
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
              disabled={!canBridge}
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
        <Card title={t('bridge.historyTitle')} data-testid="bridge-history">
          {bridges.length === 0 ? (
            <p className="muted">{t('bridge.historyEmpty')}</p>
          ) : (
            <>
              <div className="hist-controls">
                <SearchField
                  value={histQuery}
                  onChange={(v) => {
                    setHistQuery(v);
                    setHistPage(0);
                  }}
                  placeholder={t('bridge.historySearch')}
                  ariaLabel={t('bridge.historySearch')}
                  data-testid="bridge-history-search"
                />
                <Select
                  value={histEngine}
                  options={[
                    { value: 'all', label: t('bridge.filterAll') },
                    { value: 'cctp', label: t('bridge.engine.cctp') },
                    { value: 'gateway', label: t('bridge.engine.gateway') },
                  ]}
                  onChange={(v) => {
                    setHistEngine(v as 'all' | BridgeEngine);
                    setHistPage(0);
                  }}
                  ariaLabel={t('bridge.filterEngine')}
                />
              </div>

              {filteredHistory.length === 0 ? (
                <p className="muted" style={{ marginTop: 14 }}>
                  {t('bridge.historyNoMatch')}
                </p>
              ) : (
                <PagedList resetKey={histQuery} reserve={page < pageCount - 1}>
                  <div className="bridge-hist" style={{ marginTop: 14 }}>
                    {pageRows.map((b) => (
                      <div key={b.id} className="trow" data-testid="bridge-history-row">
                        <div className="bridge-hist__head">
                          <span className="bridge-hist__route">
                            <ChainLogo id={b.from} size={18} />
                            {b.fromLabel}
                            <span className="bridge-hist__arrow">&rarr;</span>
                            <ChainLogo id={b.to} size={18} />
                            {b.toLabel}
                          </span>
                          <span className="bridge-hist__meta">
                            <span className="bridge-hist__amount mono">{b.amount} USDC</span>
                            <span
                              className={`hstatus${
                                b.state === 'success'
                                  ? ' hstatus--ok'
                                  : b.state === 'error'
                                    ? ' hstatus--err'
                                    : ''
                              }`}
                            >
                              {t(`bridge.state.${b.state}` as 'bridge.state.success')}
                            </span>
                            <span className="bridge-hist__time">{relativeTime(b.createdAt)}</span>
                          </span>
                        </div>
                        {b.steps.some((s) => s.txHash && safeHttpUrl(s.explorerUrl)) && (
                          <>
                            <hr className="rule trow__rule" />
                            <div className="bridge-hist__links">
                              {b.steps
                                .filter((s) => s.txHash && safeHttpUrl(s.explorerUrl))
                                .map((s) => (
                                  <TxLink
                                    key={s.name}
                                    href={safeHttpUrl(s.explorerUrl)}
                                    label={s.name}
                                    copyValue={s.txHash ?? ''}
                                  />
                                ))}
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </PagedList>
              )}
              {filteredHistory.length > 0 && (
                <Pagination page={page} pageCount={pageCount} onChange={setHistPage} />
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
