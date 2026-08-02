import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicClient, fallback, http, isAddress, type Address, type Hex } from 'viem';
import {
  ADDRESSES,
  BlockscoutDataProvider,
  CachingDataProvider,
  CTRL_ARCZ_ADDRESS,
  MODE_PUSH,
  MODE_PULL,
  RPC_URLS,
  arcTestnet,
  buildDossier,
  check,
  type EphemeralPolicy,
} from '@ctrl-arcz/sdk';
import { investigate, investigatorEnabled } from '@ctrl-arcz/demo-kit/investigator';
import { cosign, cosignerAddress, verifiedRecipients } from '@ctrl-arcz/demo-kit/cosign';
import { bridgeUsdc } from '@ctrl-arcz/demo-kit/cctp';
import { gatewayTransfer } from '@ctrl-arcz/demo-kit/gateway';
import { gaslessClaimToResult } from '@ctrl-arcz/demo-kit/gasless';
import {
  relayCreateBox,
  relayAnnounceBox,
  relayStealthGas,
  boxExists,
} from '@ctrl-arcz/demo-kit/relay';
import { env } from './env.js';
import { json, readJson, readRaw, HttpError } from './http.js';
import { requireSignedRequest, checkQuota, takeInvestigatorBudget } from './auth.js';

/** JSON-parse a raw body already read for signature verification. */
function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

const BRIDGE_CHAIN_IDS = new Set([
  'Arc_Testnet',
  'Ethereum_Sepolia',
  'Base_Sepolia',
  'Arbitrum_Sepolia',
  'Optimism_Sepolia',
  'Avalanche_Fuji',
  'Polygon_Amoy_Testnet',
  'Unichain_Sepolia',
  'Linea_Sepolia',
  'Sonic_Testnet',
  'World_Chain_Sepolia',
]);
const GATEWAY_CHAIN_IDS = new Set([
  'Arc_Testnet',
  'Ethereum_Sepolia',
  'Base_Sepolia',
  'Avalanche_Fuji',
  'Sonic_Testnet',
]);
const MAX_BRIDGE_AMOUNT = 5; // USDC, testnet demo ceiling

/** How far back the firewall scans for RecipientVerified. Matches the co-signer. */
const VERIFIED_LOOKBACK_BLOCKS = 200_000;

/** A read client for the firewall and the dossier, on the same ranked RPC list
 *  the rest of the app uses so one rate-limited endpoint cannot stall it. */
const riskClient = createPublicClient({
  chain: arcTestnet,
  transport: fallback(RPC_URLS.map((u) => http(u, { retryCount: 1 }))),
});

/** Shared across requests: the indexer walk for a sender's history is the slow
 *  part, and a fresh provider per request would repeat it every time. */
const riskProvider = new CachingDataProvider(new BlockscoutDataProvider(), { ttlMs: 60_000 });

// --- co-signer ("The Machine") ---

export async function cosignGet(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.cosignerPk) throw new HttpError(400, 'no co-signer key configured');
  json(res, 200, { address: cosignerAddress(env.cosignerPk) });
}

export async function cosignPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.cosignerPk) throw new HttpError(400, 'no co-signer key configured');
  const body = await readJson(req);
  const result = await cosign({ privateKey: env.cosignerPk, body: body as never });
  json(res, 200, result);
}

/**
 * Everyone this sender has completed a protected transfer to.
 *
 * Public and unauthenticated on purpose: it is derived from public events, and
 * anyone can read the same logs. Making the browser sign for it would buy nothing
 * and add a wallet prompt to the send form's first render.
 */
export async function verifiedRecipientsGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const sender = url.searchParams.get('sender');
  if (!sender || !isAddress(sender)) throw new HttpError(400, 'invalid sender');
  json(res, 200, verifiedRecipients(sender as Address));
}

// --- cross-chain (shared validation for CCTP + Gateway) ---

function parseCrossChain(body: unknown, allowed: Set<string>) {
  const { from, to, amount } = (body ?? {}) as { from?: unknown; to?: unknown; amount?: unknown };
  if (typeof from !== 'string' || !allowed.has(from)) throw new HttpError(400, 'invalid source chain');
  if (typeof to !== 'string' || !allowed.has(to)) throw new HttpError(400, 'invalid destination chain');
  if (from === to) throw new HttpError(400, 'source and destination must differ');
  // Canonical USDC decimal only: no scientific notation, no whitespace, at most 6
  // decimals. We forward exactly the validated string, so the bound that was
  // checked and the value that is sent are the same quantity.
  const amtStr = typeof amount === 'number' ? String(amount) : amount;
  if (typeof amtStr !== 'string' || !/^\d+(\.\d{1,6})?$/.test(amtStr)) {
    throw new HttpError(400, 'invalid amount format');
  }
  const amt = Number(amtStr);
  if (!(amt > 0 && amt <= MAX_BRIDGE_AMOUNT)) throw new HttpError(400, 'invalid amount');
  return { from, to, amount: amtStr };
}

export async function bridgePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRaw(req);
  const caller = await requireSignedRequest(req, raw, '/api/bridge');
  const { from, to, amount } = parseCrossChain(parseBody(raw), BRIDGE_CHAIN_IDS);
  checkQuota(caller, Number(amount));
  if (!env.relayerPk) throw new HttpError(400, 'no relayer key configured');
  const result = await bridgeUsdc({ privateKey: env.relayerPk, from, to, amount } as never);
  json(res, 200, result);
}

export async function gatewayPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRaw(req);
  const caller = await requireSignedRequest(req, raw, '/api/gateway');
  const { from, to, amount } = parseCrossChain(parseBody(raw), GATEWAY_CHAIN_IDS);
  checkQuota(caller, Number(amount));
  if (!env.relayerPk) throw new HttpError(400, 'no relayer key configured');
  const result = await gatewayTransfer({ privateKey: env.relayerPk, from, to, amount } as never);
  json(res, 200, result);
}

// --- gasless claim (Circle Gas Station) ---

export async function gaslessPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRaw(req);
  const caller = await requireSignedRequest(req, raw, '/api/gasless-claim');
  checkQuota(caller, 1);
  if (!env.relayerPk) throw new HttpError(400, 'gasless not configured');
  const { transferId, code, salt } = parseBody(raw) as {
    transferId?: unknown;
    code?: unknown;
    salt?: unknown;
  };
  if (typeof transferId !== 'string' || !/^\d{1,78}$/.test(transferId)) throw new HttpError(400, 'invalid transferId');
  // The claim code is 16 Crockford base32 characters. It arrives already normalised
  // by the client, and a 6-digit value would be a pre-single-secret transfer.
  if (typeof code !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{16}$/.test(code))
    throw new HttpError(400, 'invalid code');
  if (typeof salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new HttpError(400, 'invalid salt');

  const cfg = {
    clientKey: env.circleClientKey,
    clientUrl: env.circleClientUrl,
    ownerKey: env.relayerPk,
  };
  const result = await gaslessClaimToResult(cfg as never, BigInt(transferId), code, salt as `0x${string}`);
  json(res, 200, result);
}

// --- stealth relay: keep the payer off the box's own transactions ---
//
// A stealth box costs its owner three transactions: deploy, fund, announce. Only
// the funding one has to come from the payer (it moves their USDC). The other two
// carry the payer's address for no reason other than that a browser submitted
// them, and `announce` even indexes `msg.sender`. These two routes let the relayer
// submit them instead. Nothing here can move a user's funds: `createAccount`
// deploys a clone bound to a hash of the stealth address, and `announce` emits an
// event. The relayer spends gas, so both are signed and quota-limited.

const MAX_POLICY_AMOUNT = 1_000_000_000n; // 1000 USDC in base units, testnet ceiling
const MAX_EXPIRY_SECONDS = 400 * 24 * 60 * 60; // just over a year out

function addr(v: unknown, what: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new HttpError(400, `invalid ${what}`);
  return v as Address;
}

function amount(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !/^\d{1,30}$/.test(v)) throw new HttpError(400, `invalid ${what}`);
  const n = BigInt(v);
  if (n > MAX_POLICY_AMOUNT) throw new HttpError(400, `${what} above the demo ceiling`);
  return n;
}

function seconds(v: unknown, what: string, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) {
    throw new HttpError(400, `invalid ${what}`);
  }
  return v;
}

/**
 * Rebuild the policy from named fields rather than accepting calldata. The relayer
 * signs whatever this produces, so it must never be able to produce a call the
 * operator did not intend: the token is pinned to USDC and the cosigner to this
 * server's own co-signer, which means the relayer can only ever deploy boxes that
 * The Machine still governs.
 */
function parsePolicy(body: unknown): { salt: Hex; policy: EphemeralPolicy } {
  const { salt, policy } = (body ?? {}) as { salt?: unknown; policy?: unknown };
  if (typeof salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new HttpError(400, 'invalid salt');
  }
  const p = (policy ?? {}) as Record<string, unknown>;

  if (addr(p.token, 'token').toLowerCase() !== (ADDRESSES.USDC as string).toLowerCase()) {
    throw new HttpError(400, 'only USDC boxes are relayed');
  }
  if (!env.cosignerPk) throw new HttpError(400, 'no co-signer key configured');
  const expected = cosignerAddress(env.cosignerPk);
  if (addr(p.cosigner, 'cosigner').toLowerCase() !== expected.toLowerCase()) {
    throw new HttpError(400, 'cosigner is not this server');
  }
  if (p.mode !== MODE_PUSH && p.mode !== MODE_PULL) throw new HttpError(400, 'invalid mode');

  const now = Math.floor(Date.now() / 1000);
  const expiry = seconds(p.expiry, 'expiry', now + MAX_EXPIRY_SECONDS);
  if (expiry <= now) throw new HttpError(400, 'expiry is in the past');

  return {
    salt: salt as Hex,
    policy: {
      token: ADDRESSES.USDC as Address,
      owner: addr(p.owner, 'owner'),
      cosigner: expected,
      vault: addr(p.vault, 'vault'),
      target: addr(p.target, 'target'),
      maxAmount: amount(p.maxAmount, 'maxAmount'),
      perPullMax: amount(p.perPullMax ?? '0', 'perPullMax'),
      expiry,
      interval: seconds(p.interval, 'interval', MAX_EXPIRY_SECONDS),
      mode: p.mode,
    },
  };
}

export async function relayCreatePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRaw(req);
  const caller = await requireSignedRequest(req, raw, '/api/relay/create');
  checkQuota(caller, 1);
  if (!env.relayerPk) throw new HttpError(400, 'no relayer key configured');
  const body = parseBody(raw);
  const { salt, policy } = parsePolicy(body);
  const result = await relayCreateBox(env.relayerPk, salt, policy);

  // Announce in the same call, when asked to.
  //
  // Deploying a stealth box and publishing the announcement that makes it findable
  // are one act from the user's side, and splitting them across two signed requests
  // charged them a second wallet dialog for the second half of something they had
  // already authorised. Doing it here also removes the ordering hazard the split
  // had: the announcement now cannot be published before the box it names exists,
  // because the deploy above is awaited.
  const announce = (body as { announce?: { stealthAddress?: unknown; ephemeralPubKey?: unknown } })
    .announce;
  let announceTx: { txHash: Hex } | null = null;
  if (announce) {
    if (
      typeof announce.ephemeralPubKey !== 'string' ||
      !/^0x[0-9a-fA-F]{66}$/.test(announce.ephemeralPubKey)
    ) {
      throw new HttpError(400, 'invalid ephemeralPubKey');
    }
    announceTx = await relayAnnounceBox(
      env.relayerPk,
      {
        stealthAddress: addr(announce.stealthAddress, 'stealthAddress'),
        ephemeralPubKey: announce.ephemeralPubKey as Hex,
      },
      result.account,
    );
  }
  json(res, 200, { ...result, announceTx });
}

export async function relayAnnouncePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRaw(req);
  const caller = await requireSignedRequest(req, raw, '/api/relay/announce');
  checkQuota(caller, 1);
  if (!env.relayerPk) throw new HttpError(400, 'no relayer key configured');

  const { stealthAddress, ephemeralPubKey, box } = parseBody(raw) as {
    stealthAddress?: unknown;
    ephemeralPubKey?: unknown;
    box?: unknown;
  };
  // 33-byte compressed secp256k1 point, as ERC-5564 specifies for scheme 1.
  if (typeof ephemeralPubKey !== 'string' || !/^0x[0-9a-fA-F]{66}$/.test(ephemeralPubKey)) {
    throw new HttpError(400, 'invalid ephemeralPubKey');
  }
  const stealth = { stealthAddress: addr(stealthAddress, 'stealthAddress'), ephemeralPubKey: ephemeralPubKey as Hex };
  const boxAddr = addr(box, 'box');

  // An announcement for an address with no code would be a relayer-funded lie, and
  // the scanner on the other side would hand the payer a box that cannot be swept.
  if (!(await boxExists(env.relayerPk, boxAddr))) throw new HttpError(400, 'box does not exist');

  const result = await relayAnnounceBox(env.relayerPk, stealth, boxAddr);
  json(res, 200, result);
}

// --- the investigator: judgement the rule engine deliberately does not make ---
//
// The firewall answers one question at a time, the same way every time. That is
// what makes it worth trusting, and it also means "this address has no on-chain
// history" is all it can say about a colleague's new wallet and about a contract
// that would swallow the payment. This route gathers the signals a single rule
// cannot combine and reports what they add up to.
//
// It can only ever tighten. `investigate` clamps its answer to the rule engine's
// verdict before returning, so a wrong or prompt-injected reply can refuse a good
// payment but can never approve a bad one. And it is optional: with no API key,
// on a timeout, or on a malformed reply it returns null and the app behaves
// exactly as it does without the feature.

export async function investigatePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Unauthenticated on purpose. This route moves no money: it reads public chain
  // data and returns an opinion that can only tighten a verdict. Demanding a
  // wallet signature made the user pay a prompt to be warned about their own
  // payment, and made the app ask for one on every page load -- which is how
  // people are trained to click through the prompts that do matter.
  //
  // The per-IP window in `http.ts` covers a single abuser; `takeInvestigatorBudget`
  // bounds the operator's model spend however many addresses or IPs show up.
  const raw = await readRaw(req);
  const { target, sender: claimedSender } = parseBody(raw) as {
    target?: unknown;
    sender?: unknown;
  };
  // The sender is claimed rather than proven, and that is fine here: everything
  // read about it is already public on the explorer, and nothing is spent on its
  // behalf. It never authorises anything -- it only selects whose history the
  // lookalike rule compares against.
  const sender = addr(claimedSender, 'sender');
  const targetAddress = addr(target, 'target');

  const report = await check(sender, targetAddress, {
    client: riskClient,
    provider: riskProvider,
    contractAddress: CTRL_ARCZ_ADDRESS,
    verifiedRecipientsLookbackBlocks: VERIFIED_LOOKBACK_BLOCKS,
  });

  // No key, or the day's model budget is spent: answer with the rules alone. The
  // app is built to behave identically when the investigator says nothing.
  if (!investigatorEnabled(env.anthropicApiKey) || !takeInvestigatorBudget()) {
    json(res, 200, { rule: report, advisory: null, dossier: null });
    return;
  }

  const dossier = await buildDossier(report, {
    publicClient: riskClient,
    provider: riskProvider,
    usdcAddress: ADDRESSES.USDC as Address,
  });
  const advisory = await investigate(env.anthropicApiKey, dossier);

  json(res, 200, { rule: report, advisory, dossier });
}

export async function relayGasPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRaw(req);
  const caller = await requireSignedRequest(req, raw, '/api/relay/gas');
  checkQuota(caller, 1);
  if (!env.relayerPk) throw new HttpError(400, 'no relayer key configured');
  const { to } = parseBody(raw) as { to?: unknown };
  const result = await relayStealthGas(env.relayerPk, addr(to, 'to'));
  json(res, 200, result);
}
