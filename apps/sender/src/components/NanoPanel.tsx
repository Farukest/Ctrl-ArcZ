import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { depositToGateway, type GatewayStep } from '@ctrl-arcz/sdk';
import type { Session } from '@ctrl-arcz/demo-kit';
import {
  AmountField,
  Button,
  CopyButton,
  CopyRow,
  Field,
  Input,
  NanoMeter,
  Notice,
  Stepper,
  UsageFeed,
  UsageGauge,
  gaugeTone,
  parseAmount,
  short,
  useSubmitGuard,
  useT,
  useToast,
  type Step,
  type UsageItem,
} from '@ctrl-arcz/demo-kit/ui';
import { signedPost } from '../lib/signedPost.js';
import { useWalletUsdc } from '../lib/balances.js';
import { bumpBalances } from '../lib/balanceStore.js';

/**
 * Claude API, paid per request with Circle Gateway Nanopayments.
 *
 * What replaces the subscription form when the merchant bills per request. There
 * is no box and no schedule: the user loads a Gateway balance for their agent
 * wallet, points any Anthropic client at their own base URL, and every request is
 * paid from that balance as it is made. The server holds the agent key, because
 * the requests come from wherever the user runs Claude; the balance is all it can
 * spend and the rest comes back with one button.
 *
 * Everything on screen is read back from Circle: the balance from Gateway, each
 * row's settlement state from Circle's transfer records.
 */

interface NanoSession {
  agent: Address;
  apiKey: string;
  model: string;
}

interface NanoEntry {
  at: string;
  model: string;
  amount: string;
  inputTokens: number | null;
  outputTokens: number | null;
  circleId: string | null;
  circleStatus: string | null;
}

interface NanoState {
  agent: Address;
  price: string;
  available: string;
  spent: string;
  requests: number;
  entries: NanoEntry[];
}

const POLL_MS = 3_000;
/** Gateway credits a deposit once Arc has finalised it; this is how long we wait for that. */
const CREDIT_TIMEOUT_MS = 180_000;

const sessionKey = (address: string) => `ctrlarcz.nano.${address.toLowerCase()}`;

function loadSession(address: string): NanoSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(address));
    return raw ? (JSON.parse(raw) as NanoSession) : null;
  } catch {
    return null;
  }
}

function saveSession(address: string, s: NanoSession): void {
  try {
    localStorage.setItem(sessionKey(address), JSON.stringify(s));
  } catch {
    // Private window: the next visit asks for one more signature.
  }
}

/** `claude-haiku-4.5` as people say it: Claude Haiku 4.5. */
function modelLabel(id: string): string {
  return id
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Sub-cent amounts need the fourth decimal; whole ones do not. */
function usdc(v: bigint | string): string {
  const n = Number(BigInt(v)) / 1e6;
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 4 })} USDC`;
}

const CIRCLE_STATES = new Set(['received', 'batched', 'completed', 'failed']);

async function readState(address: string): Promise<NanoState> {
  const res = await fetch(`/api/nano/state?address=${address}`);
  const body = (await res.json()) as NanoState & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `state unavailable (${res.status})`);
  return body;
}

export function NanoPanel({ session }: { session: Session }) {
  const t = useT();
  const toast = useToast();
  const guard = useSubmitGuard();
  const address = session.address as Address;

  const [nano, setNano] = useState<NanoSession | null>(() => loadSession(address));
  const [state, setState] = useState<NanoState | null>(null);
  const [amount, setAmount] = useState('0.10');
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [activating, setActivating] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const walletBal = useWalletUsdc('Arc', session.chainId, address);
  const seen = useRef<Set<string> | null>(null);
  // Read through refs: `t` and `toast` are new on every render, and as
  // dependencies of `refresh` they re-ran the polling effect on every render,
  // which fetched, re-rendered and fetched again until the API rate-limited it.
  const tRef = useRef(t);
  const toastRef = useRef(toast);
  tRef.current = t;
  toastRef.current = toast;

  useEffect(() => {
    setNano(loadSession(address));
    setState(null);
    seen.current = null;
  }, [address]);

  const refresh = useCallback(async () => {
    try {
      const next = await readState(address);
      setState(next);
      // A row the list has not shown before is a payment that just went through.
      // The first read only fills the memory; nothing on it is news.
      const keys = next.entries.map((e) => e.at);
      if (seen.current) {
        const arrived = next.entries.filter((e) => !seen.current!.has(e.at));
        if (arrived.length > 0) {
          setFresh(new Set(arrived.map((e) => e.at)));
          for (const e of arrived) {
            toastRef.current.push(tRef.current('nano.paidToast', { amount: usdc(e.amount) }), 'success');
          }
        }
      }
      seen.current = new Set(keys);
      return next;
    } catch {
      return null;
    }
  }, [address]);

  useEffect(() => {
    if (!nano) return;
    void refresh();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [nano, refresh]);

  async function activate() {
    setActivating(true);
    try {
      const s = await signedPost<NanoSession>(session, '/api/nano/session', {});
      const next = { agent: s.agent, apiKey: s.apiKey, model: s.model };
      saveSession(address, next);
      setNano(next);
    } catch (e) {
      toast.fail(e);
    } finally {
      setActivating(false);
    }
  }

  async function load() {
    if (!nano) return;
    const value = parseAmount(amount);
    if (!value || value <= 0n) return;
    const before = BigInt(state?.available ?? '0');
    const mark = (i: number, status: Step['status']) =>
      setSteps((cur) => cur && cur.map((s, j) => (j === i ? { ...s, status } : s)));
    setSteps([
      { label: t('nano.step.approve'), status: 'active' },
      { label: t('nano.step.deposit'), status: 'pending' },
      { label: t('nano.step.credit'), status: 'pending' },
    ]);
    let at = 0;
    try {
      await depositToGateway(session.clients, {
        chain: 'Arc',
        amount: value,
        depositor: nano.agent,
        onStep: (step: GatewayStep) => {
          if (step === 'approve') {
            mark(0, 'done');
            mark(1, 'active');
            at = 1;
          } else if (step === 'deposit') {
            mark(1, 'done');
            mark(2, 'active');
            at = 2;
          }
        },
      });
      // The wallet paid: its balance on screen is out of date from here.
      bumpBalances();
      const deadline = Date.now() + CREDIT_TIMEOUT_MS;
      for (;;) {
        const next = await refresh();
        if (next && BigInt(next.available) >= before + value) break;
        if (Date.now() > deadline) throw new Error('Circle has not credited the deposit yet. It will appear here once it does.');
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      mark(2, 'done');
      toast.push(t('nano.loadedToast'), 'success');
      setTimeout(() => setSteps(null), 2_500);
    } catch (e) {
      mark(at, 'error');
      toast.fail(e);
    }
  }

  async function ask() {
    if (!nano || !question.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      const res = await fetch('/api/nano/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': nano.apiKey },
        body: JSON.stringify({
          model: nano.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: question.trim() }],
        }),
      });
      const body = (await res.json()) as { content?: { type: string; text?: string }[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      setAnswer((body.content ?? []).map((c) => c.text ?? '').join('').trim());
      setQuestion('');
      void refresh();
    } catch (e) {
      toast.fail(e);
    } finally {
      setAsking(false);
    }
  }

  async function withdraw() {
    setWithdrawing(true);
    try {
      const r = await signedPost<{ amount: string }>(session, '/api/nano/withdraw', {});
      toast.push(t('nano.withdrawnToast', { amount: usdc(r.amount) }), 'success');
      void refresh();
    } catch (e) {
      toast.fail(e);
    } finally {
      setWithdrawing(false);
    }
  }

  if (!nano) {
    return (
      <div className="formstack" data-testid="nano-panel">
        <Notice tone="info">{t('nano.lead')}</Notice>
        <Button full loading={activating} onClick={() => void guard(activate)} data-testid="nano-activate">
          {t('nano.activate')}
        </Button>
      </div>
    );
  }

  const available = BigInt(state?.available ?? '0');
  const spent = BigInt(state?.spent ?? '0');
  const price = BigInt(state?.price ?? '3000');
  const base = available + spent;
  const fraction = state ? (base > 0n ? Number(available) / Number(base) : null) : null;
  const requestsLeft = state ? Number(available / price) : null;
  const tone = gaugeTone(fraction, requestsLeft);
  const statusText = {
    ok: t('nano.statusOk'),
    warn: t('nano.statusWarn'),
    critical: t('nano.statusCritical'),
    empty: t('nano.statusEmpty'),
  }[tone];

  const items: UsageItem[] = (state?.entries ?? []).map((e) => ({
    id: e.at,
    time: new Date(e.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
    title: modelLabel(e.model),
    detail:
      e.inputTokens != null && e.outputTokens != null
        ? t('nano.tokens', { in: String(e.inputTokens), out: String(e.outputTokens) })
        : '',
    amount: `-${usdc(e.amount)}`,
    status: t(
      `nano.circle.${CIRCLE_STATES.has(e.circleStatus ?? '') ? e.circleStatus : 'pending'}` as 'nano.circle.pending',
    ),
    fresh: fresh.has(e.at),
  }));

  const loadValue = parseAmount(amount);
  const baseUrl = `${window.location.origin}/api/nano`;

  return (
    <div className="formstack" data-testid="nano-panel">
      <Notice tone="info">{t('nano.lead')}</Notice>

      <NanoMeter
        stats={[
          { label: t('nano.left'), value: state ? usdc(available) : '-', testId: 'nano-available' },
          { label: t('nano.perRequest'), value: usdc(price) },
          { label: t('nano.requestsLeft'), value: requestsLeft ?? '-', testId: 'nano-requests-left' },
          { label: t('nano.spent'), value: usdc(spent), testId: 'nano-spent' },
          {
            label: t('nano.agent'),
            value: (
              <span className="row" style={{ gap: 6 }}>
                {short(nano.agent)}
                <CopyButton value={nano.agent} />
              </span>
            ),
          },
        ]}
        gauge={<UsageGauge fraction={fraction} tone={tone} status={statusText} />}
      />

      <AmountField
        value={amount}
        onChange={setAmount}
        chain="Arc"
        label={t('nano.loadTitle')}
        balance={walletBal.value ?? null}
        balanceMissing={walletBal.value === undefined ? 'loading' : 'unavailable'}
        boxed
      />
      {steps && <Stepper steps={steps} />}
      <Button
        full
        loading={!!steps && steps.some((s) => s.status === 'active')}
        disabled={!loadValue || loadValue <= 0n}
        onClick={() => void guard(load)}
        data-testid="nano-load"
      >
        {t('nano.load')}
      </Button>

      <Field label={t('nano.accessTitle')}>
        <div className="formstack">
          <CopyRow label={t('nano.baseUrl')} value={baseUrl} testId="nano-url" />
          <CopyRow label={t('nano.apiKey')} value={nano.apiKey} testId="nano-key" />
          <div className="row" style={{ gap: 8 }}>
            <Input
              className="grow"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void guard(ask);
              }}
              placeholder={t('nano.tryPh')}
              data-testid="nano-question"
            />
            <Button
              loading={asking}
              disabled={!question.trim() || available < price}
              onClick={() => void guard(ask)}
              data-testid="nano-ask"
            >
              {t('nano.try')}
            </Button>
          </div>
          {answer && (
            <Notice tone="ok" testId="nano-answer">
              {answer}
            </Notice>
          )}
        </div>
      </Field>

      <Field label={state?.requests ? `${t('nano.feedTitle')} · ${state.requests}` : t('nano.feedTitle')}>
        <UsageFeed items={items} empty={t('nano.feedEmpty')} />
      </Field>

      <Button
        variant="ghost"
        full
        loading={withdrawing}
        disabled={available <= 0n}
        onClick={() => void guard(withdraw)}
        data-testid="nano-withdraw"
      >
        {t('nano.withdraw')}
      </Button>
    </div>
  );
}
