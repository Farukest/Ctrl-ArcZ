import {
  createPublicClient,
  fallback,
  http,
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  LocalCoSigner,
  readAccount,
  check,
  VerifiedRecipientIndex,
  AnnouncementIndex,
  cosignAuthMessage,
  arcTestnet,
  RPC_URLS,
  CTRL_ARCZ_ADDRESS,
  SPEND_POLICY_FACTORY_ADDRESS,
  spendPolicyFactoryAbi,
  ACTION_PAY,
  ACTION_PULL,
  type CosignAuthScope,
  type AuthorizeRequest,
  type AuthorizeResult,
  type CounterfactualRequest,
  type PrecheckResult,
  type RiskVerdict,
  type SpendAction,
} from '@ctrl-arcz/sdk';

/**
 * Server-only co-signer ("The Machine"). Runs the enclave's job off the browser:
 * read the account's REAL policy from chain, validate the request against it and
 * the poisoning firewall, then return the signature or a veto. The co-signer key
 * stays server-side.
 *
 * Trust boundary: the browser sends only {account, owner, amount, action}. The
 * authoritative target, nonce, remaining and expiry are read from chain HERE, so
 * a compromised client cannot talk the enclave into signing something the policy
 * would not allow. Fail-closed: if the firewall's data source is unreachable, the
 * risk check returns incomplete and the co-signer withholds its signature.
 */

/** The wire shape the browser POSTs. Only these fields are trusted; everything
 *  else about the policy is read from chain. `phase: 'precheck'` runs the firewall
 *  alone (before the account exists); otherwise the server reads the account's
 *  policy from chain and signs. */
export interface CosignBody {
  phase?: 'precheck' | 'sign' | 'sign-cf';
  account?: string;
  owner?: string;
  target?: string;
  amount?: string;
  action?: number;
  /** F3: the payer signs cosignAuthMessage(owner, ts) to prove control of owner. */
  ownerSig?: string;
  ownerSigTs?: number;
  /** 'sign-cf' (batched one-off): the server recomputes the box from these and signs
   *  nonce 0 for a box that does not exist yet. `box` is the client's prediction,
   *  which must equal the server's recomputation. */
  box?: string;
  ownerHash?: string;
  salt?: string;
  policy?: {
    token?: string;
    cosigner?: string;
    vaultHash?: string;
    target?: string;
    maxAmount?: string;
    perPullMax?: string;
    expiry?: number;
    interval?: number;
    mode?: number;
  };
}

/** Reconstruct the exact auth scope the client signed, from the request body. Must
 *  mirror RemoteCoSigner.authBody: precheck binds {target, amount}; sign binds
 *  {account, amount, action}. */
function authScopeOf(body: CosignBody): CosignAuthScope | null {
  if (body.amount == null || !/^\d+$/.test(String(body.amount))) return null;
  const amount = BigInt(body.amount);
  if (body.phase === 'precheck') {
    if (!body.target || !isAddress(body.target)) return null;
    return { target: body.target as Address, amount };
  }
  // 'sign-cf' binds the owner-auth to the predicted box (in `box`); it is only
  // trusted after the server confirms `box` equals its own recomputation.
  const acct = body.phase === 'sign-cf' ? body.box : body.account;
  if (!acct || !isAddress(acct)) return null;
  const action = body.action === ACTION_PULL ? ACTION_PULL : ACTION_PAY;
  return { account: acct as Address, amount, action };
}

/** Verify the payer controls `owner` AND that the signature is bound to THIS
 *  request (not a replay of another spend). Returns a veto on failure, or null. */
async function verifyOwnerAuth(
  body: CosignBody,
): Promise<{ approved: false; reason: string } | null> {
  const { owner, ownerSig, ownerSigTs } = body;
  if (!owner || !isAddress(owner) || typeof ownerSig !== 'string' || typeof ownerSigTs !== 'number') {
    return { approved: false, reason: 'owner authentication required' };
  }
  if (Math.abs(Date.now() - ownerSigTs) > 120_000) {
    return { approved: false, reason: 'stale owner authentication' };
  }
  const scope = authScopeOf(body);
  if (!scope) {
    return { approved: false, reason: 'owner authentication required' };
  }
  // Single-use: a captured owner signature cannot be replayed within the window.
  const seenAt = usedOwnerSigs.get(ownerSig);
  if (seenAt !== undefined && Date.now() - seenAt < 120_000) {
    return { approved: false, reason: 'owner authentication already used' };
  }
  const recovered = await recoverMessageAddress({
    message: cosignAuthMessage(owner as Address, ownerSigTs, scope),
    signature: ownerSig as Hex,
  });
  if (recovered.toLowerCase() !== owner.toLowerCase()) {
    return { approved: false, reason: 'owner authentication failed' };
  }
  usedOwnerSigs.set(ownerSig, Date.now());
  return null;
}

// Anti-replay store for owner-auth signatures, swept to the freshness window.
const usedOwnerSigs = new Map<string, number>();
(setInterval(() => {
  const now = Date.now();
  for (const [k, t] of usedOwnerSigs) if (now - t >= 120_000) usedOwnerSigs.delete(k);
}, 120_000) as unknown as { unref?: () => void }).unref?.();

/**
 * The public Arc RPC returns JSON-RPC error -32011 "request limit reached" under
 * load, which viem does not retry. Wrap the transport to back off and retry on
 * exactly that. Without this, the co-signer's `readAccount` (several reads at once)
 * can 502 on a rate-limit blip. Mirrors the browser session's transport.
 *
 * Few retries on purpose: this sits inside a `fallback` over the whole ranked RPC
 * list, so the right response to one endpoint refusing is to try the next one, not
 * to sit on the same endpoint for half a minute. Retrying hard against a single URL
 * is what turned a rate-limit blip into "the risk check was incomplete" and a
 * blocked payment, because the co-signer fails closed when the check throws.
 */
function rlHttp(url: string): Transport {
  const inner = http(url, { retryCount: 2, retryDelay: 800, timeout: 15_000 });
  return ((params) => {
    const t = inner(params);
    const request = async (args: unknown, opts?: unknown) => {
      for (let i = 0; ; i++) {
        try {
          return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts);
        } catch (e) {
          const m = String((e as Error)?.message ?? e);
          if (i < 2 && /request limit|rate limit|429|-32011/i.test(m)) {
            await new Promise((r) => setTimeout(r, 700));
            continue;
          }
          throw e;
        }
      }
    };
    return { ...t, request } as typeof t;
  }) as Transport;
}

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: fallback(RPC_URLS.map((u) => rlHttp(u))),
  // Coalesce readAccount's several reads into one Multicall3 RPC request — this is
  // what keeps the policy read under the public RPC's rate limit.
  batch: { multicall: { wait: 20 } },
});

// Dedicated indexer: backfills the sender->verified-recipients map once, then polls
// incrementally, so the firewall never does a from-deploy-block getLogs scan on a
// cosign request (that scan was the ~220s cold-start / 504 bottleneck).
const recipientIndex = new VerifiedRecipientIndex(publicClient, CTRL_ARCZ_ADDRESS);
void recipientIndex.start();

/**
 * The sender's verified recipients, from the index the co-signer already keeps
 * warm. Exposed so the browser can stop guessing with a block lookback.
 *
 * A bounded scan cannot answer this question. Arc produces roughly nineteen
 * blocks a second, so the 200k-block window the client used covers about three
 * hours — meaning the lookalike rule silently stopped protecting anyone paid
 * before that. This index backfills from the deploy block once and then follows
 * the chain, so `complete` means complete.
 */
export function verifiedRecipients(sender: Address): { recipients: Address[]; complete: boolean } {
  return { recipients: recipientIndex.recipientsOf(sender), complete: recipientIndex.isReady() };
}

// The same treatment for stealth announcements. The announcer is one global
// registry with no on-chain owner tag, so a browser looking for its own boxes had
// to read all 2.16 million blocks of it -- 217 chunked requests -- on every visit,
// and that span grows by 1.6 million blocks a day.
const announcementIndex = new AnnouncementIndex(publicClient);
void announcementIndex.start();

/**
 * Every stealth announcement at or after `fromBlock`, with the head they are
 * complete to.
 *
 * Public data, served identically to everyone, and that is the point. Recognising
 * which announcements belong to a wallet needs its viewing key; the key is derived
 * from a wallet signature and never leaves the browser, so the client does the
 * matching itself against this list. Accepting a viewing key here would be simpler
 * and would give away the exact thing stealth addresses exist to protect.
 */
export function announcements(fromBlock = 0n): ReturnType<AnnouncementIndex['since']> {
  return announcementIndex.since(fromBlock);
}

/**
 * Firewall-backed risk source: the SDK poisoning check, mapped to a verdict.
 *
 * The check runs a chunked `eth_getLogs` scan, which is the heaviest RPC path
 * here. A payment asks the co-signer twice (pre-flight, then the signature), and
 * both hit the same (owner, target). So cache each verdict briefly: the pre-flight
 * computes it, the signature reuses it, and the scan runs once per payment instead
 * of twice. A compromised client that swaps the target after the pre-flight lands
 * on a different key, misses the cache, and is scanned fresh — the guarantee holds.
 * On an RPC failure we return null (fail-closed veto) rather than throwing, so a
 * rate-limit blip is a clean "try again", never a 502.
 */
// Cache a verdict just long enough to cover the precheck->sign pair of a single
// payment, NOT a whole session. A long TTL was a real TOCTOU window: an attacker
// could warm `owner:target` to "safe", then plant a 0-value bait from `target`, and
// the co-signer would keep serving the cached safe past the point a fresh scan
// would block it. 60s bounds that window to the immediate payment flow. (With the
// indexer serving verified recipients, the remaining per-scan cost is small, so a
// short TTL is cheap.)
const VERDICT_TTL_MS = 60_000;
const verdictCache = new Map<string, { verdict: RiskVerdict; exp: number }>();
(setInterval(() => {
  const now = Date.now();
  for (const [k, v] of verdictCache) if (v.exp <= now) verdictCache.delete(k);
}, VERDICT_TTL_MS) as unknown as { unref?: () => void }).unref?.();

async function riskCheck(owner: Address, target: Address): Promise<RiskVerdict | null> {
  const key = `${owner.toLowerCase()}:${target.toLowerCase()}`;
  const hit = verdictCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.verdict;
  try {
    // Once the indexer has backfilled, feed its list so check() does zero on-chain
    // scanning. While it is still backfilling (server just started), fall back to a
    // bounded recent-blocks scan instead of a full from-deploy-block one.
    const scanOpts = recipientIndex.isReady()
      ? { verifiedRecipients: recipientIndex.recipientsOf(owner) }
      : { verifiedRecipientsLookbackBlocks: 200_000 };
    const report = await check(owner, target, {
      client: publicClient,
      contractAddress: CTRL_ARCZ_ADDRESS,
      ...scanOpts,
    });
    const verdict: RiskVerdict = {
      level: report.level,
      complete: report.complete,
      reasons: report.reasons.map((r) => r.message),
    };
    // Only cache once the indexer has backfilled. A verdict computed during the
    // cold-start bounded fallback could miss an older verified recipient (so a
    // lookalike of it might pass as "safe"); caching that would extend the gap.
    // Recompute fresh until the index is complete.
    if (recipientIndex.isReady()) {
      verdictCache.set(key, { verdict, exp: Date.now() + VERDICT_TTL_MS });
    }
    return verdict;
  } catch {
    return null; // fail-closed; the co-signer withholds its signature
  }
}

/** Build the authoritative request: trust the caller only for {account, owner,
 *  amount, action}; read target/nonce/remaining/expiry from chain. */
async function reconstruct(body: CosignBody): Promise<AuthorizeRequest> {
  if (!body.account || !isAddress(body.account)) throw new Error('invalid account');
  if (!body.owner || !isAddress(body.owner)) throw new Error('invalid owner');
  if (body.amount == null || !/^\d+$/.test(String(body.amount))) throw new Error('invalid amount');
  const action: SpendAction = body.action === ACTION_PULL ? ACTION_PULL : ACTION_PAY;

  const state = await readAccount(publicClient, body.account as Address);

  return {
    account: body.account as Address,
    owner: body.owner as Address,
    amount: BigInt(body.amount),
    action,
    target: state.target,
    nonce: state.nonce,
    chainId: arcTestnet.id,
    remaining: state.remaining,
    expiry: state.expiry,
    perPullMax: state.perPullMax,
    interval: state.interval,
    lastPull: state.lastPull,
  };
}

/** Handle a 'sign-cf' request: recompute the box address from the policy, reject any
 *  mismatch with the client's prediction, then co-sign nonce 0 for it. */
async function signCounterfactual(
  machine: LocalCoSigner,
  body: CosignBody,
): Promise<AuthorizeResult> {
  const p = body.policy;
  if (
    !body.owner || !isAddress(body.owner) ||
    !body.box || !isAddress(body.box) ||
    !body.ownerHash || !/^0x[0-9a-fA-F]{64}$/.test(body.ownerHash) ||
    !body.salt || !/^0x[0-9a-fA-F]{64}$/.test(body.salt) ||
    body.amount == null || !/^\d+$/.test(String(body.amount)) ||
    !p || !p.token || !isAddress(p.token) || !p.cosigner || !isAddress(p.cosigner) ||
    !p.vaultHash || !/^0x[0-9a-fA-F]{64}$/.test(p.vaultHash) ||
    !p.target || !isAddress(p.target) ||
    p.maxAmount == null || !/^\d+$/.test(String(p.maxAmount)) ||
    p.perPullMax == null || !/^\d+$/.test(String(p.perPullMax)) ||
    typeof p.expiry !== 'number' || typeof p.interval !== 'number' || typeof p.mode !== 'number'
  ) {
    return { approved: false, reason: 'invalid counterfactual request' };
  }

  const initParams = {
    token: p.token as Address,
    cosigner: p.cosigner as Address,
    vaultHash: p.vaultHash as Hex,
    target: p.target as Address,
    maxAmount: BigInt(p.maxAmount),
    perPullMax: BigInt(p.perPullMax),
    expiry: p.expiry,
    interval: p.interval,
    mode: p.mode,
  } as const;

  // Recompute the box address independently. If it does not equal the client's `box`,
  // the client's owner-auth is bound to an address its policy does not produce: reject.
  let predicted: Address;
  try {
    predicted = (await publicClient.readContract({
      address: SPEND_POLICY_FACTORY_ADDRESS,
      abi: spendPolicyFactoryAbi,
      functionName: 'predictAddress',
      args: [body.ownerHash as Hex, body.salt as Hex, initParams],
    })) as Address;
  } catch {
    return { approved: false, reason: 'address prediction unavailable (fail-closed); try again' };
  }
  if (predicted.toLowerCase() !== body.box.toLowerCase()) {
    return { approved: false, reason: 'box does not match the provided policy' };
  }

  const req: CounterfactualRequest = {
    factory: SPEND_POLICY_FACTORY_ADDRESS,
    ownerHash: body.ownerHash as Hex,
    salt: body.salt as Hex,
    box: predicted,
    owner: body.owner as Address,
    amount: BigInt(body.amount),
    chainId: arcTestnet.id,
    policy: {
      token: initParams.token,
      cosigner: initParams.cosigner,
      vaultHash: initParams.vaultHash,
      target: initParams.target,
      maxAmount: initParams.maxAmount,
      perPullMax: initParams.perPullMax,
      expiry: initParams.expiry,
      interval: initParams.interval,
      mode: initParams.mode,
    },
  };
  return machine.authorizeCounterfactual(req);
}

export async function cosign(
  params: { privateKey: Hex; body: CosignBody },
): Promise<AuthorizeResult | PrecheckResult> {
  const machine = new LocalCoSigner(params.privateKey, { riskCheck });

  // F3: authenticate the payer before doing anything with their `owner` scope.
  //
  // Not for the pre-flight. That phase issues no co-signature, touches no account
  // and moves nothing: it runs the poisoning firewall over two public addresses
  // and says yes or no. A signature there proved only that the asker owned the
  // address they were asking about, which is not a fact worth a wallet dialog --
  // and it cost one, in the middle of a form, before the box being asked about
  // even existed. Every phase that puts the co-signer's name on something still
  // authenticates, because those spend.
  if (params.body.phase !== 'precheck') {
    const authFail = await verifyOwnerAuth(params.body);
    if (authFail) return authFail;
  }

  // Pre-flight: firewall only, before any account exists. No chain read, no sig.
  if (params.body.phase === 'precheck') {
    const { owner, target, amount } = params.body;
    if (!owner || !isAddress(owner)) throw new Error('invalid owner');
    if (!target || !isAddress(target)) throw new Error('invalid target');
    if (amount == null || !/^\d+$/.test(String(amount))) throw new Error('invalid amount');
    return machine.precheck({ owner, target, amount: BigInt(amount) });
  }

  // Batched one-off (create+fund+pay in one tx): the box does not exist yet, so the
  // server recomputes its address from the policy and signs nonce 0. The recompute
  // is what makes it safe — a client cannot bind the signature to a box its policy
  // does not map to.
  if (params.body.phase === 'sign-cf') {
    return signCounterfactual(machine, params.body);
  }

  // Sign: authoritative — read the account's real policy from chain, then sign.
  // A read failure (e.g. an RPC rate-limit blip) is a fail-closed veto, not a 502.
  let request: AuthorizeRequest;
  try {
    request = await reconstruct(params.body);
  } catch (e) {
    if (e instanceof Error && /invalid /.test(e.message)) throw e; // bad input -> 4xx path
    return { approved: false, reason: 'policy read unavailable (fail-closed); try again' };
  }
  return machine.authorize(request);
}

/** The co-signer's public address — the UI locks it into each account it creates. */
export function cosignerAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}
