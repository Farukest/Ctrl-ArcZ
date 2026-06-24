import { useMemo, useState } from 'react';
import {
  BRIDGE_CHAINS,
  BRIDGE_STEPS,
  bridgeChainLabel,
  type BridgeChainName,
  type BridgeOutcome,
} from '@ctrl-arcz/demo-kit';
import {
  Button,
  Card,
  ChainLogo,
  Field,
  Input,
  Pagination,
  paginate,
  Select,
  Stepper,
  useSubmitGuard,
  useT,
  useToast,
  IconExternal,
  type Step,
} from '@ctrl-arcz/demo-kit/ui';
import { loadBridges, saveBridge, type StoredBridge } from '../store.js';

// The bridge signs server-side (/api/bridge), so the client never needs the key;
// gate on a non-secret flag instead of inlining a private key just to read a bool.
const bridgeEnabled = import.meta.env.VITE_BRIDGE_ENABLED !== 'false';
const HISTORY_PAGE_SIZE = 5;

/** Map a Bridge Kit step name ("approve"/"burn"/"mint") to its stepper index. */
function stepIndexForName(name: string): number {
  const n = name.toLowerCase();
  if (n.includes('approve')) return 0;
  if (n.includes('burn')) return 1;
  if (n.includes('attest')) return 2;
  if (n.includes('mint')) return 3;
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

export function BridgeTab() {
  const t = useT();
  const toast = useToast();
  const guard = useSubmitGuard();
  const [from, setFrom] = useState<BridgeChainName>('Arc_Testnet');
  const [to, setTo] = useState<BridgeChainName>('Base_Sepolia');
  const [amount, setAmount] = useState('0.1');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BridgeOutcome | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [bridges, setBridges] = useState<StoredBridge[]>(() => loadBridges());
  const [histQuery, setHistQuery] = useState('');
  const [histPage, setHistPage] = useState(0);

  const amountValue = Number(amount);
  const sameChain = from === to;
  const canBridge = bridgeEnabled && amountValue > 0 && !sameChain && !busy;

  const chainOptions = BRIDGE_CHAINS.map((c) => ({
    value: c.id,
    label: c.label,
    text: c.label,
    icon: <ChainLogo id={c.id} size={20} />,
  }));

  const steps: Step[] = useMemo(() => {
    const done = result?.state === 'success';
    return BRIDGE_STEPS.map((name) => ({
      label: t(`bridge.step.${name}`),
      status: done ? 'done' : busy ? 'active' : 'pending',
    }));
  }, [busy, result, t]);

  const filteredHistory = useMemo(() => {
    const q = histQuery.trim().toLowerCase();
    return q ? bridges.filter((b) => bridgeHaystack(b).includes(q)) : bridges;
  }, [bridges, histQuery]);

  const pageCount = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE));
  const page = Math.min(histPage, pageCount - 1);
  const pageRows = paginate(filteredHistory, page, HISTORY_PAGE_SIZE);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/bridge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, amount }),
      });
      const data = (await res.json()) as BridgeOutcome | { error: string };
      if (!res.ok || 'error' in data) {
        throw new Error('error' in data ? data.error : `bridge failed (${res.status})`);
      }
      setResult(data);
      saveBridge({
        id: `${from}-${to}-${Date.now()}`,
        from,
        to,
        fromLabel: bridgeChainLabel(from),
        toLabel: bridgeChainLabel(to),
        amount,
        state: data.state,
        steps: data.steps.map((s) => ({
          name: s.name,
          ...(s.txHash ? { txHash: s.txHash } : {}),
          ...(s.explorerUrl ? { explorerUrl: s.explorerUrl } : {}),
        })),
        createdAt: Date.now(),
      });
      setBridges(loadBridges());
      setHistPage(0);
      toast.push(
        data.state === 'success' ? t('bridge.done') : t('bridge.failed'),
        data.state === 'success' ? 'success' : 'error',
      );
    } catch (e) {
      toast.push(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title={t('bridge.title')} data-testid="bridge-tab">
        <p className="muted">{t('bridge.body')}</p>
        <ul className="hintlist">
          <li>{t('bridge.point1')}</li>
          <li>{t('bridge.point2')}</li>
          <li>{t('bridge.point3')}</li>
        </ul>

        <hr className="rule" />

        <div className="bridge-route-row">
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

        {(busy || result) && <Stepper steps={steps} highlightIndex={hoverIdx} />}

        <div style={{ marginTop: 16 }}>
          <Button
            full
            onClick={() => void guard(run)}
            loading={busy}
            disabled={!canBridge}
            data-testid="bridge-button"
          >
            {busy ? t('bridge.bridging') : t('bridge.button')}
          </Button>
        </div>
        {!bridgeEnabled && <p className="hint">{t('bridge.noKey')}</p>}

        {result?.state === 'success' && (
          <div className="row wrap" style={{ marginTop: 14 }} data-testid="bridge-success">
            {result.steps
              .filter((s) => s.txHash && safeHttpUrl(s.explorerUrl))
              .map((s) => (
                <a
                  key={s.name}
                  className="linkbtn"
                  href={safeHttpUrl(s.explorerUrl)}
                  target="_blank"
                  rel="noreferrer"
                  title={t(`bridge.step.${BRIDGE_STEPS[stepIndexForName(s.name)] ?? 'mint'}`)}
                  onMouseEnter={() => setHoverIdx(stepIndexForName(s.name))}
                  onMouseLeave={() => setHoverIdx(null)}
                >
                  {s.name} <IconExternal width={13} height={13} />
                </a>
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
              <Input
                value={histQuery}
                onChange={(e) => {
                  setHistQuery(e.target.value);
                  setHistPage(0);
                }}
                placeholder={t('bridge.historySearch')}
                aria-label={t('bridge.historySearch')}
                data-testid="bridge-history-search"
              />

              {filteredHistory.length === 0 ? (
                <p className="muted" style={{ marginTop: 12 }}>
                  {t('bridge.historyNoMatch')}
                </p>
              ) : (
                <div className="bridge-hist" style={{ marginTop: 8 }}>
                  {pageRows.map((b) => (
                    <div key={b.id} className="bridge-hist__row" data-testid="bridge-history-row">
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
                      <div className="row wrap" style={{ gap: 8 }}>
                        {b.steps
                          .filter((s) => s.txHash && safeHttpUrl(s.explorerUrl))
                          .map((s) => (
                            <a
                              key={s.name}
                              className="linkbtn"
                              href={safeHttpUrl(s.explorerUrl)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {s.name} <IconExternal width={13} height={13} />
                            </a>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Pagination page={page} pageCount={pageCount} onChange={setHistPage} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
