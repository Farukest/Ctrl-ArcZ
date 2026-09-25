import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import {
  createWalletClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  concat,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARC_MAINNET_RPC_URL, arcMainnet, quoteGatewaySpend, spendFromGateway } from '@ctrl-arcz/sdk';
import { HttpError } from './http.js';

/**
 * Pay-per-request Claude, paid with Circle Gateway Nanopayments.
 *
 * Each user gets an agent wallet: an EOA derived on this server from a secret and
 * the user's address, so it needs no database and is the same after a restart. The
 * user funds its Gateway balance from their own wallet (`depositFor`), and every
 * request that reaches the proxy is paid from that balance with an x402 signature,
 * at the moment it is made. Circle has no post-paid metering; the payment travels
 * with the request.
 *
 * The key has to live here, because the requests it pays for come from wherever
 * the user runs Claude, not from their browser. What bounds that is the balance:
 * the key can spend what was loaded and nothing else, it holds no other asset, and
 * the user can pull the rest back at any time.
 */

/** Circle Agent Marketplace listing: Claude via BlockRun, paid on Arc. */
export const NANO_SERVICE = {
  name: 'Claude API',
  provider: 'BlockRun',
  url: 'https://nano.blockrun.ai/api/v1/messages',
  defaultModel: 'claude-haiku-4.5',
  /** What BlockRun quoted for Haiku on 2026-09-25, in USDC subunits. Display only. */
  listPrice: 3_000n,
} as const;

/**
 * The most one request may cost. BlockRun prices each request before it runs, from
 * the model and the requested tokens; a request priced above this is refused
 * before anything is signed, so a large prompt cannot drain a budget in one go.
 */
const MAX_PRICE = 20_000n;

const ARC_MAINNET = 5042;

function secret(): Buffer {
  const s = process.env.NANO_AGENT_SECRET;
  if (!s || s.length < 32) throw new HttpError(503, 'pay-per-request is not configured');
  return Buffer.from(s);
}

export function agentKeyFor(user: Address): Hex {
  return keccak256(concat([toBytes('ctrl-arcz:nano-agent:v1'), secret(), toBytes(user.toLowerCase())]));
}

export function agentAddressFor(user: Address): Address {
  return privateKeyToAccount(agentKeyFor(user)).address;
}

function mac(user: Address): string {
  return createHmac('sha256', secret()).update(`token:${user.toLowerCase()}`).digest('hex').slice(0, 40);
}

/** The API key a user puts wherever they run Claude. Names the user; proves nothing without the MAC. */
export function tokenFor(user: Address): string {
  return `ctz_${user.slice(2).toLowerCase()}_${mac(user)}`;
}

export function userForToken(token: string | undefined): Address {
  const m = /^ctz_([0-9a-f]{40})_([0-9a-f]{40})$/.exec(token ?? '');
  if (!m) throw new HttpError(401, 'missing or malformed API key');
  const user = getAddress(`0x${m[1]}`);
  const expected = Buffer.from(mac(user));
  const given = Buffer.from(m[2] as string);
  if (!timingSafeEqual(expected, given)) throw new HttpError(401, 'invalid API key');
  return user;
}

/**
 * A fresh client per use. Hooks registered on a client stay registered, so a
 * shared one would run every earlier request's price check and nonce capture on
 * every later request.
 */
function gatewayFor(user: Address): GatewayClient {
  return new GatewayClient({ chain: 'arc', privateKey: agentKeyFor(user), rpcUrl: ARC_MAINNET_RPC_URL });
}

// ---------------------------------------------------------------------------
// Usage log
//
// Circle's transfer records carry the amount, the time and the settlement state,
// but not what was bought. The model and token counts are only known here, so each
// paid request is written down, keyed by the authorization nonce Circle also keeps,
// and the two are joined when the screen asks.
// ---------------------------------------------------------------------------

export interface UsageEntry {
  user: string;
  at: string;
  model: string;
  amount: string;
  nonce: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** A withdrawal closes a cycle; the gauge measures spend since the last one. */
  kind: 'request' | 'withdraw';
}

const LOG_PATH = process.env.NANO_LOG_PATH || '.data/nano-usage.jsonl';
const usage = new Map<string, UsageEntry[]>();

function loadLog(): void {
  try {
    for (const line of readFileSync(LOG_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as UsageEntry;
      const list = usage.get(e.user) ?? [];
      list.push(e);
      usage.set(e.user, list);
    }
  } catch {
    // No log yet.
  }
}
loadLog();

function record(e: UsageEntry): void {
  stateCache.delete(e.user);
  const list = usage.get(e.user) ?? [];
  list.push(e);
  usage.set(e.user, list);
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify(e)}\n`);
  } catch (err) {
    console.error('nano usage log write failed:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/**
 * Accept the model names people actually type. The Anthropic SDKs send
 * `claude-haiku-4-5`; BlockRun lists `claude-haiku-4.5`.
 */
function normaliseModel(model: unknown): string {
  if (typeof model !== 'string' || !model) return NANO_SERVICE.defaultModel;
  return model.replace(/^anthropic\//, '').replace(/-(\d+)-(\d+)(-\d{8})?$/, '-$1.$2');
}

export async function payForMessage(
  user: Address,
  body: Record<string, unknown>,
): Promise<{ data: unknown; amount: bigint }> {
  const gateway = gatewayFor(user);
  const model = normaliseModel(body.model);
  let nonce: string | null = null;
  let price: bigint | null = null;

  gateway
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      price = BigInt(selectedRequirements.amount);
      if (price > MAX_PRICE) {
        return { abort: true, reason: `priced at ${Number(price) / 1e6} USDC, above the per-request cap` };
      }
    })
    .onAfterPaymentCreation(async ({ paymentPayload }) => {
      const auth = (paymentPayload as { payload?: { authorization?: { nonce?: string } } }).payload
        ?.authorization;
      nonce = auth?.nonce ?? null;
    });

  // pay() reads the reply as JSON, so the proxy is non-streaming.
  const result = await gateway.pay(NANO_SERVICE.url, {
    method: 'POST',
    body: { ...body, model, stream: false },
  });

  const amount = BigInt(result.amount ?? price ?? 0n);
  const u = (result.data as { usage?: { input_tokens?: number; output_tokens?: number } })?.usage;
  record({
    user: user.toLowerCase(),
    at: new Date().toISOString(),
    model,
    amount: amount.toString(),
    nonce,
    inputTokens: u?.input_tokens ?? null,
    outputTokens: u?.output_tokens ?? null,
    kind: 'request',
  });
  return { data: result.data, amount };
}

// ---------------------------------------------------------------------------
// State for the screen
// ---------------------------------------------------------------------------

interface CircleTransfer {
  id: string;
  status: string;
  amount: string;
  nonce: string;
  createdAt: string;
}

async function circleTransfers(agent: Address): Promise<CircleTransfer[]> {
  try {
    const res = await fetch(
      `https://gateway-api.circle.com/v1/x402/transfers?from=${agent}&network=eip155:${ARC_MAINNET}&pageSize=50`,
    );
    if (!res.ok) return [];
    return ((await res.json()) as { transfers?: CircleTransfer[] }).transfers ?? [];
  } catch {
    return [];
  }
}

/**
 * The panel polls every few seconds and may be open in more than one tab, so a
 * read is kept briefly. Everything in it comes from Circle's APIs, never from an
 * RPC: the balance from Gateway, the settlement states from the transfer log.
 */
const STATE_TTL_MS = 2_000;
const stateCache = new Map<string, { at: number; value: Promise<Awaited<ReturnType<typeof readNanoState>>> }>();

export function nanoState(user: Address) {
  const k = user.toLowerCase();
  const hit = stateCache.get(k);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.value;
  const value = readNanoState(user);
  stateCache.set(k, { at: Date.now(), value });
  value.catch(() => stateCache.delete(k));
  return value;
}

async function readNanoState(user: Address) {
  const agent = agentAddressFor(user);
  const [balance, transfers] = await Promise.all([gatewayFor(user).getBalance(), circleTransfers(agent)]);
  const byNonce = new Map(transfers.map((t) => [t.nonce.toLowerCase(), t]));

  const all = usage.get(user.toLowerCase()) ?? [];
  const lastWithdraw = all.map((e) => e.kind).lastIndexOf('withdraw');
  const cycle = all.slice(lastWithdraw + 1).filter((e) => e.kind === 'request');
  const spent = cycle.reduce((s, e) => s + BigInt(e.amount), 0n);

  const entries = cycle
    .slice(-30)
    .reverse()
    .map((e) => {
      const t = e.nonce ? byNonce.get(e.nonce.toLowerCase()) : undefined;
      return {
        at: e.at,
        model: e.model,
        amount: e.amount,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        circleId: t?.id ?? null,
        circleStatus: t?.status ?? null,
      };
    });

  return {
    agent,
    service: { name: NANO_SERVICE.name, provider: NANO_SERVICE.provider, model: NANO_SERVICE.defaultModel },
    price: NANO_SERVICE.listPrice.toString(),
    available: balance.available.toString(),
    spent: spent.toString(),
    requests: cycle.length,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------

/**
 * Everything left, back to the user's wallet on Arc, through Gateway.
 *
 * A same-chain Gateway spend with Circle's forwarder submitting the mint, so the
 * agent needs no gas and never holds USDC outside Gateway. The fee comes out of the
 * balance, so what arrives is the balance less the quoted fee.
 */
export async function withdrawAll(user: Address): Promise<{ amount: bigint; transferId: string }> {
  const agentKey = agentKeyFor(user);
  const agent = privateKeyToAccount(agentKey).address;
  const available = (await gatewayFor(user).getBalance()).available;
  if (available <= 0n) throw new HttpError(400, 'nothing to withdraw');

  const quote = await quoteGatewaySpend({ from: 'Arc', to: 'Arc', amount: available, depositor: agent, recipient: user });
  const amount = available - quote.maxFee;
  if (amount <= 0n) throw new HttpError(400, 'the balance does not cover the withdrawal fee');

  // The intent is signed, not sent: Circle's forwarder submits the mint.
  const walletClient = createWalletClient({
    account: privateKeyToAccount(agentKey),
    chain: arcMainnet,
    transport: http(ARC_MAINNET_RPC_URL),
  });
  const result = await spendFromGateway({ walletClient }, { from: 'Arc', to: 'Arc', amount, recipient: user });
  record({
    user: user.toLowerCase(),
    at: new Date().toISOString(),
    model: '',
    amount: amount.toString(),
    nonce: null,
    inputTokens: null,
    outputTokens: null,
    kind: 'withdraw',
  });
  return { amount, transferId: result.transferId };
}

export function parseUser(v: unknown): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new HttpError(400, 'invalid address');
  return getAddress(v);
}
