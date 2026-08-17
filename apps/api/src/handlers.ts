import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicClient, erc20Abi, fallback, http, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ADDRESSES,
  ARC_TOKENS,
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
  type TokenInfo,
} from '@ctrl-arcz/sdk';
import { investigate, investigatorEnabled } from '@ctrl-arcz/demo-kit/investigator';
import {
  announcements,
  cosign,
  cosignerAddress,
  verifiedRecipients,
} from '@ctrl-arcz/demo-kit/cosign';
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

/**
 * Every stealth announcement, so a browser can find its own boxes without reading
 * the chain.
 *
 * The announcer is one global registry and carries no owner tag by design, so
 * discovery means testing every announcement against a viewing key. Doing that
 * from the browser cost 217 chunked `eth_getLogs` calls over 2.16 million blocks,
 * on every visit, growing daily. This serves the same list from an index that
 * backfilled once.
 *
 * Public and unauthenticated, exactly like the verified-recipients route: these
 * are public events and anyone can read the same logs. Crucially it is also
 * **undirected** -- it takes no address and returns the same bytes to every
 * caller. Recognising which announcements are yours needs the viewing key, which
 * stays in the browser, so the server cannot build a map of boxes to owners even
 * if it were asked to.
 */
export async function announcementsGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const raw = url.searchParams.get('fromBlock');
  // A bad cursor must not be read as "give me everything from zero" silently, and
  // must not throw either: reject it so a client bug is visible.
  if (raw !== null && !/^\d{1,20}$/.test(raw)) throw new HttpError(400, 'invalid fromBlock');
  json(res, 200, announcements(raw ? BigInt(raw) : 0n));
}

/**
 * Health, plus the one number that has twice been the invisible cause of a "broken"
 * feature.
 *
 * Every bridge in this demo spends the relayer's own USDC, not the user's. When that
 * wallet empties, every route fails at once and the app can only report that
 * something went wrong. That happened on 5 August: 0.4158 USDC on Arc against a demo
 * that sends 0.5, and the first signal was a person unable to use the app.
 *
 * The address is public and the balance is on a block explorer, so nothing here is a
 * secret. What is new is that it can be read without knowing which address to look
 * at, which is the whole difficulty when it fails.
 */
export async function healthGet(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.relayerPk) return json(res, 200, { ok: true, relayer: null });
  const address = privateKeyToAccount(env.relayerPk).address;
  const usdc = await riskClient
    .readContract({
      address: ADDRESSES.USDC as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    })
    .catch(() => null);
  // On Arc the USDC balance is also the gas balance, so one number covers both. Low
  // is a warning, not an error: the API is healthy, its wallet is not.
  const balance = usdc == null ? null : Number(usdc) / 1e6;
  json(res, 200, {
    ok: true,
    relayer: {
      address,
      arcUsdc: balance,
      low: balance != null && balance < LOW_RELAYER_BALANCE,
      ...(balance != null && balance < LOW_RELAYER_BALANCE
        ? {
            warning: `Relayer USDC on Arc is ${balance}. Box deploys, announcements and gasless claims stop when it runs out.`,
          }
        : {}),
    },
  });
}

/** Below this, the relayer is a few box deploys away from refusing to work. */
const LOW_RELAYER_BALANCE = 5;

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

/**
 * Tokens this relayer will deploy a box for.
 *
 * A set of server-side constants, never anything the caller supplies. The
 * property that matters is not "the token is USDC", it is that the relayer can
 * only ever be talked into signing a call the operator chose; a fixed list keeps
 * that exactly as a single pinned address did.
 *
 * Resolved from the registry rather than written out again, so the addresses and
 * the decimals below cannot drift from the ones the apps send.
 */
const RELAYABLE_TOKENS: readonly TokenInfo[] = ARC_TOKENS.filter(
  (t) => t.symbol === 'USDC' || t.symbol === 'EURC',
);

function relayableToken(v: unknown): TokenInfo {
  const wanted = addr(v, 'token').toLowerCase();
  const found = RELAYABLE_TOKENS.find((t) => t.address.toLowerCase() === wanted);
  if (!found) {
    throw new HttpError(
      400,
      `only ${RELAYABLE_TOKENS.map((t) => t.symbol).join(' and ')} boxes are relayed`,
    );
  }
  return found;
}

/**
 * The testnet ceiling, in whole tokens rather than in base units.
 *
 * It used to be `1_000_000_000n` with a comment saying "1000 USDC", which is the
 * same thing only while every token has six decimals. Written this way the limit
 * means a thousand of whatever is being sent, on a token with eight decimals as
 * much as on one with six, and nobody has to remember to re-derive it.
 */
const MAX_POLICY_TOKENS = 1000n;
const MAX_EXPIRY_SECONDS = 400 * 24 * 60 * 60; // just over a year out

function addr(v: unknown, what: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new HttpError(400, `invalid ${what}`);
  return v as Address;
}

function amount(v: unknown, what: string, token: TokenInfo): bigint {
  if (typeof v !== 'string' || !/^\d{1,30}$/.test(v)) throw new HttpError(400, `invalid ${what}`);
  const n = BigInt(v);
  const ceiling = MAX_POLICY_TOKENS * 10n ** BigInt(token.decimals);
  if (n > ceiling) throw new HttpError(400, `${what} above the demo ceiling`);
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
 * operator did not intend: the token has to be one of this server's own, and the
 * cosigner has to be this server's own co-signer, which means the relayer can only
 * ever deploy boxes that The Machine still governs.
 */
export function parsePolicy(body: unknown): { salt: Hex; policy: EphemeralPolicy } {
  const { salt, policy } = (body ?? {}) as { salt?: unknown; policy?: unknown };
  if (typeof salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new HttpError(400, 'invalid salt');
  }
  const p = (policy ?? {}) as Record<string, unknown>;

  const token = relayableToken(p.token);
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
      // The matched entry, not the string that was sent. Comparing and then
      // writing back the caller's value would make the check advisory: two
      // addresses that compare equal case-insensitively are still two strings,
      // and only one of them came from us.
      token: token.address,
      owner: addr(p.owner, 'owner'),
      cosigner: expected,
      vault: addr(p.vault, 'vault'),
      target: addr(p.target, 'target'),
      maxAmount: amount(p.maxAmount, 'maxAmount', token),
      perPullMax: amount(p.perPullMax ?? '0', 'perPullMax', token),
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
  const announce = (
    body as {
      announce?: { stealthAddress?: unknown; ephemeralPubKey?: unknown; label?: unknown };
    }
  ).announce;
  let announceTx: { txHash: Hex } | null = null;
  if (announce) {
    if (
      typeof announce.ephemeralPubKey !== 'string' ||
      !/^0x[0-9a-fA-F]{66}$/.test(announce.ephemeralPubKey)
    ) {
      throw new HttpError(400, 'invalid ephemeralPubKey');
    }
    // The box's name, published with it so every device shows the same one. Bounded
    // because it goes into calldata this relayer pays for, and a caller should not
    // be able to make that bill arbitrarily large.
    const label = typeof announce.label === 'string' ? announce.label.trim().slice(0, 40) : '';
    announceTx = await relayAnnounceBox(
      env.relayerPk,
      {
        stealthAddress: addr(announce.stealthAddress, 'stealthAddress'),
        ephemeralPubKey: announce.ephemeralPubKey as Hex,
      },
      result.account,
      label,
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
