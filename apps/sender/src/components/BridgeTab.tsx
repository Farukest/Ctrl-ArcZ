import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@ctrl-arcz/demo-kit';
import {
  activeJobIds,
  forgetJob,
  readBridgeJob,
  startBridgeJob,
  type BridgeJob,
} from '../lib/bridgeJob.js';
import {
  BRIDGE_STEPS,
  GATEWAY_STEPS,
  GATEWAY_CHAINS,
  chainsForEngine,
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
  const [from, setFrom] = useState<BridgeChainName>('Arc_Testnet');
  const [to, setTo] = useState<BridgeChainName>('Base_Sepolia');
  const [amount, setAmount] = useState('0.1');
  const [result, setResult] = useState<BridgeOutcome | null>(null);
  /** Every transfer this browser is following, live from the server. */
  const [jobs, setJobs] = useState<BridgeJob[]>([]);
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
  const running = jobs.filter((j) => j.state === 'running').length;
  const canBridge = bridgeEnabled && amountValue > 0 && !sameChain;

  const chainOptions = chainsForEngine(engine).map((c) => ({
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
      const ids = GATEWAY_CHAINS.map((c) => c.id);
      if (!ids.includes(from)) setFrom('Arc_Testnet');
      if (!ids.includes(to)) setTo('Base_Sepolia');
    }
  };

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
    const reported = job?.steps ?? [];
    const finished = job && job.state !== 'running';
    return activeSteps.map((name) => {
      const at = reported.findIndex((r) => r.name === name);
      if (finished) {
        const st = reported[at]?.state;
        return { label: stepLabel(name), status: st === 'error' ? 'error' : at >= 0 ? 'done' : 'pending' };
      }
      if (at < 0) return { label: stepLabel(name), status: 'pending' };
      // The most recent report is the one still running; anything before it is done.
      const isLast = at === reported.length - 1;
      return { label: stepLabel(name), status: isLast ? 'active' : 'done' };
    }) as Step[];
  }, [job, activeSteps, t, engine]);

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

  async function run() {
    setResult(null);
    try {
      const jobId = await startBridgeJob(session, engine, { from, to, amount });
      // The server owns the transfer now. Everything after this is observation, so
      // the form goes straight back to usable: a second bridge does not have to wait
      // half a minute for the first, and locking the button was only ever a symptom
      // of the page having nowhere to keep more than one.
      setJobs((prev) => [
        ...prev,
        { jobId, engine, from, to, amount, state: 'running', steps: [], startedAt: Date.now() },
      ]);
    } catch (e) {
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
                onChange={(v) => setFrom(v as BridgeChainName)}
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
                onChange={(v) => setTo(v as BridgeChainName)}
                ariaLabel={t('bridge.to')}
                searchable
                searchPlaceholder={t('bridge.searchChain')}
                noResultsText={t('common.noResults')}
                full
              />
            </Field>
          </div>
        </div>
        {sameChain && <p className="hint">{t('bridge.sameChain')}</p>}

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

        {(result || job) && <Stepper steps={steps} highlightIndex={hoverIdx} />}

        <div style={{ marginTop: 16 }}>
          <Button
            full
            onClick={() => void guard(run)}
            disabled={!canBridge}
            data-testid="bridge-button"
          >
            {running > 0 ? t('bridge.buttonAnother') : t('bridge.button')}
          </Button>
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
