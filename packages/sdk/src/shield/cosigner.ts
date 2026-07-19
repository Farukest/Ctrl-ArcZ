import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { spendTypedData, type SpendAction, ACTION_PAY, ACTION_PULL } from './digest.js';

/**
 * The co-signer ("The Machine") — the enclave that authorizes every spend. It does
 * NOT merely warn like an extension-based guard; it withholds the signature, so a
 * spend that fails policy or the risk firewall is physically impossible, not a
 * click-through. Here it runs in-process for tests and the demo; in production the
 * same logic runs inside a TEE holding the co-signer key.
 *
 * Trust boundary: the co-signer validates against the account's REAL on-chain
 * policy, never against values a caller supplied. The request it receives carries
 * only what the chain cannot provide — which account, which owner (for the risk
 * lookup), how much, and which action; the authoritative `target`, `nonce`,
 * `remaining` and `expiry` are read from chain by the caller that owns the trust
 * boundary (the server in `RemoteCoSigner`'s case), not by the browser.
 */

/** What the firewall must answer for a target. Mirrors the SDK `check()` report. */
export interface RiskVerdict {
  level: 'safe' | 'warning' | 'block';
  complete: boolean;
  reasons?: string[];
}

/** A pluggable risk source. Returns null when it could not answer (data down). */
export type RiskCheck = (owner: Address, target: Address) => Promise<RiskVerdict | null>;

/** The minimal, trust-agnostic ask a browser may hand the co-signer. */
export interface SpendRequest {
  account: Address;
  owner: Address;
  amount: bigint;
  action: SpendAction;
}

/** A spend request joined with the account's chain-read policy. Built by the party
 *  that owns the trust boundary, never by the browser. */
export interface AuthorizeRequest extends SpendRequest {
  target: Address;
  nonce: bigint;
  chainId: number;
  remaining: bigint;
  expiry: number; // unix seconds
  /** PULL only: the per-pull cap and interval, read from chain. */
  perPullMax?: bigint;
  interval?: number; // seconds
  lastPull?: number; // unix seconds; 0 if never pulled
  /** Current time (unix seconds); injectable for tests. */
  now?: number;
}

export type AuthorizeResult =
  | { approved: true; signature: Hex }
  | { approved: false; reason: string; riskReasons?: string[] };

/** A pre-flight ask: run only the risk firewall on the intended target, before any
 *  account exists. Lets the flow veto a bad payment before anything is created. */
export interface PrecheckRequest {
  owner: Address;
  target: Address;
  amount: bigint;
}

/** The shape of a veto (shared by precheck and authorize). */
export type Veto = { approved: false; reason: string; riskReasons?: string[] };

export type PrecheckResult = { approved: true } | Veto;

export interface CoSigner {
  precheck(req: PrecheckRequest): Promise<PrecheckResult>;
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
  readonly address: Address;
}

export interface LocalCoSignerOptions {
  /** Risk source; if omitted the co-signer treats every target as unknown and, by
   *  fail-closed policy, vetoes. Supply the SDK `check()` (wrapped) in production. */
  riskCheck?: RiskCheck;
  /** Veto threshold. `block` (default) stops only hard blocks; `warning` is stricter. */
  vetoOn?: 'block' | 'warning';
}

const SEVERITY = { safe: 0, warning: 1, block: 2 } as const;

/**
 * In-process co-signer for tests and the server. Fail-closed: any policy breach,
 * risk block, or unavailable risk data withholds the signature.
 */
export class LocalCoSigner implements CoSigner {
  readonly address: Address;
  private readonly signer: ReturnType<typeof privateKeyToAccount>;
  private readonly riskCheck: RiskCheck | undefined;
  private readonly vetoThreshold: number;

  constructor(privateKey: Hex, opts: LocalCoSignerOptions = {}) {
    this.signer = privateKeyToAccount(privateKey);
    this.address = this.signer.address;
    this.riskCheck = opts.riskCheck;
    this.vetoThreshold = SEVERITY[opts.vetoOn ?? 'block'];
  }

  /** The risk firewall alone. Fail-closed: no risk source, or a source that could
   *  not answer, is a veto. Returns null when the target is clean. */
  private async _risk(owner: Address, target: Address): Promise<Veto | null> {
    if (!this.riskCheck) {
      return { approved: false, reason: 'no risk source configured (fail-closed)' };
    }
    const verdict = await this.riskCheck(owner, target).catch(() => null);
    if (!verdict) {
      return { approved: false, reason: 'risk data unavailable (fail-closed)' };
    }
    if (SEVERITY[verdict.level] >= this.vetoThreshold) {
      return {
        approved: false,
        reason: `risk firewall vetoed the target (${verdict.level})`,
        ...(verdict.reasons ? { riskReasons: verdict.reasons } : {}),
      };
    }
    return null;
  }

  /** Pre-flight: run the firewall before any account exists, so a bad payment is
   *  vetoed before anything is created or funded. */
  async precheck(req: PrecheckRequest): Promise<PrecheckResult> {
    if (req.amount <= 0n) return { approved: false, reason: 'amount must be positive' };
    const veto = await this._risk(req.owner, req.target);
    return veto ?? { approved: true };
  }

  /** Validate a chain-sourced request and either co-sign it or veto. */
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    // 1. Policy, from the chain-read state. The contract re-checks these, but the
    //    co-signer refuses to put its name on a request that violates them.
    if (req.amount <= 0n) {
      return { approved: false, reason: 'amount must be positive' };
    }
    if (req.amount > req.remaining) {
      return { approved: false, reason: 'amount exceeds the remaining policy limit' };
    }
    const now = req.now ?? Math.floor(Date.now() / 1000);
    if (now > req.expiry) {
      return { approved: false, reason: 'policy window has expired' };
    }

    // 1b. PULL-specific policy: the per-pull cap and interval (the real
    //     subscription guarantee). The contract enforces both, but the co-signer
    //     refuses to sign a request that would revert.
    if (req.action === ACTION_PULL) {
      if (req.perPullMax != null && req.perPullMax > 0n && req.amount > req.perPullMax) {
        return { approved: false, reason: 'amount exceeds the per-pull cap' };
      }
      if (
        req.interval != null &&
        req.lastPull != null &&
        req.lastPull !== 0 &&
        now < req.lastPull + req.interval
      ) {
        return { approved: false, reason: 'too soon since the last pull' };
      }
    }

    // 2. Risk firewall on the CHAIN target. Fail-closed.
    const veto = await this._risk(req.owner, req.target);
    if (veto) return veto;

    // 3. Clean: co-sign the exact EIP-712 spend the contract will verify.
    const signature = await this.signer.signTypedData(
      spendTypedData({
        account: req.account,
        chainId: req.chainId,
        target: req.target,
        amount: req.amount,
        nonce: req.nonce,
        action: req.action,
      }),
    );
    return { approved: true, signature };
  }
}

/**
 * A co-signer that lives behind an HTTP endpoint — the real shape: "The Machine"
 * runs server-side (a TEE), never in the browser. The browser hands it only the
 * trust-agnostic {account, owner, amount, action}; the server reads the account's
 * real policy from chain and returns a signature or a veto. Nothing the browser
 * says about the policy is trusted.
 */
export class RemoteCoSigner implements CoSigner {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly endpoint: string,
    readonly address: Address,
    fetchImpl?: typeof fetch,
  ) {
    // The global `fetch` must be invoked with `this === window`; storing it as a
    // property and calling `this.fetchImpl(...)` would rebind `this` to this
    // instance and throw "Illegal invocation". Wrap it so the global is always
    // called correctly, in both the browser and Node.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Pre-flight the firewall on the intended target before any account exists. */
  async precheck(req: PrecheckRequest): Promise<PrecheckResult> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phase: 'precheck',
        owner: req.owner,
        target: req.target,
        amount: req.amount.toString(),
      }),
    });
    const data = (await res.json()) as PrecheckResult;
    if (!res.ok && !('approved' in data)) {
      return { approved: false, reason: `co-signer error (${res.status})` };
    }
    return data;
  }

  /** Forwards ONLY the trust-agnostic fields; the server re-reads the policy from
   *  chain, so anything the browser claims about target/nonce/remaining/expiry is
   *  ignored by design. */
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: req.account,
        owner: req.owner,
        amount: req.amount.toString(),
        action: req.action ?? ACTION_PAY,
      }),
    });
    const data = (await res.json()) as
      | { approved: true; signature: Hex }
      | { approved: false; reason: string; riskReasons?: string[] };
    if (!res.ok && !('approved' in data)) {
      return { approved: false, reason: `co-signer error (${res.status})` };
    }
    return data;
  }
}
