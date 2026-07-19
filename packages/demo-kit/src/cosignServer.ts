import {
  createPublicClient,
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
  cosignAuthMessage,
  arcTestnet,
  RPC_URL,
  CTRL_ARCZ_ADDRESS,
  ACTION_PAY,
  ACTION_PULL,
  type AuthorizeRequest,
  type AuthorizeResult,
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
  phase?: 'precheck' | 'sign';
  account?: string;
  owner?: string;
  target?: string;
  amount?: string;
  action?: number;
  /** F3: the payer signs cosignAuthMessage(owner, ts) to prove control of owner. */
  ownerSig?: string;
  ownerSigTs?: number;
}

/** Verify the payer controls `owner` before the firewall is scoped to their
 *  history. Returns a veto on failure, or null when authenticated. */
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
  const recovered = await recoverMessageAddress({
    message: cosignAuthMessage(owner as Address, ownerSigTs),
    signature: ownerSig as Hex,
  });
  if (recovered.toLowerCase() !== owner.toLowerCase()) {
    return { approved: false, reason: 'owner authentication failed' };
  }
  return null;
}

/**
 * The public Arc RPC returns JSON-RPC error -32011 "request limit reached" under
 * load, which viem does not retry. Wrap the transport to back off and retry on
 * exactly that. Without this, the co-signer's `readAccount` (several reads at once)
 * can 502 on a rate-limit blip. Mirrors the browser session's transport.
 */
function rlHttp(url: string): Transport {
  const inner = http(url, { retryCount: 6, retryDelay: 1200, timeout: 30_000 });
  return ((params) => {
    const t = inner(params);
    const request = async (args: unknown, opts?: unknown) => {
      for (let i = 0; ; i++) {
        try {
          return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts);
        } catch (e) {
          const m = String((e as Error)?.message ?? e);
          if (i < 20 && /request limit|rate limit|429|-32011/i.test(m)) {
            await new Promise((r) => setTimeout(r, 1800));
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
  transport: rlHttp(RPC_URL),
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
// The poisoning-log scan is heavy against the rate-limited public RPC, so cache a
// verdict long enough that a target is scanned once per session, not per payment.
// (A shorter TTL is safer for production, where a fresh scan per payment is cheap
// on a dedicated RPC; this value suits the public-RPC demo.)
const VERDICT_TTL_MS = 30 * 60_000;
const verdictCache = new Map<string, { verdict: RiskVerdict; exp: number }>();

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
    verdictCache.set(key, { verdict, exp: Date.now() + VERDICT_TTL_MS });
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

export async function cosign(
  params: { privateKey: Hex; body: CosignBody },
): Promise<AuthorizeResult | PrecheckResult> {
  const machine = new LocalCoSigner(params.privateKey, { riskCheck });

  // F3: authenticate the payer before doing anything with their `owner` scope.
  const authFail = await verifyOwnerAuth(params.body);
  if (authFail) return authFail;

  // Pre-flight: firewall only, before any account exists. No chain read, no sig.
  if (params.body.phase === 'precheck') {
    const { owner, target, amount } = params.body;
    if (!owner || !isAddress(owner)) throw new Error('invalid owner');
    if (!target || !isAddress(target)) throw new Error('invalid target');
    if (amount == null || !/^\d+$/.test(String(amount))) throw new Error('invalid amount');
    return machine.precheck({ owner, target, amount: BigInt(amount) });
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
