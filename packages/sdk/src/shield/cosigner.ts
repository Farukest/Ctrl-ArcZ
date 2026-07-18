import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { payStructHash } from './digest.js';

/**
 * The co-signer ("The Machine") — the enclave half of the 2-of-2. It does NOT
 * merely warn like an extension-based guard; it withholds the second signature,
 * so a spend that fails policy or the risk firewall is physically impossible, not
 * a click-through. Here it runs in-process for tests and the demo; in production
 * the same logic runs inside a TEE holding the co-signer key.
 */

/** What the firewall must answer for a target. Mirrors the SDK `check()` report. */
export interface RiskVerdict {
  level: 'safe' | 'warning' | 'block';
  complete: boolean;
  reasons?: string[];
}

/** A pluggable risk source. Returns null when it could not answer (data down). */
export type RiskCheck = (owner: Address, target: Address) => Promise<RiskVerdict | null>;

export interface AuthorizeRequest {
  account: Address;
  owner: Address;
  target: Address;
  amount: bigint;
  nonce: bigint;
  chainId: bigint;
  /** On-chain policy snapshot the co-signer validates the request against. */
  policy: {
    lockedTarget: Address;
    remaining: bigint;
    expiry: number; // unix seconds
  };
  /** Current time (unix seconds); injectable for tests. */
  now?: number;
}

export type AuthorizeResult =
  | { approved: true; signature: Hex }
  | { approved: false; reason: string; riskReasons?: string[] };

export interface CoSigner {
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
 * In-process co-signer for tests and the demo. Fail-closed: any policy breach,
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

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    // 1. Policy: the request must match the account's on-chain locked policy. Even
    //    though the contract re-checks these, the co-signer refuses to put its
    //    name on a request that violates them.
    if (req.target.toLowerCase() !== req.policy.lockedTarget.toLowerCase()) {
      return { approved: false, reason: 'target does not match the locked policy target' };
    }
    if (req.amount <= 0n) {
      return { approved: false, reason: 'amount must be positive' };
    }
    if (req.amount > req.policy.remaining) {
      return { approved: false, reason: 'amount exceeds the remaining policy limit' };
    }
    const now = req.now ?? Math.floor(Date.now() / 1000);
    if (now > req.policy.expiry) {
      return { approved: false, reason: 'policy window has expired' };
    }

    // 2. Risk firewall. Fail-closed: no risk source, or a source that could not
    //    answer, means we cannot clear the target, so we veto.
    if (!this.riskCheck) {
      return { approved: false, reason: 'no risk source configured (fail-closed)' };
    }
    const verdict = await this.riskCheck(req.owner, req.target).catch(() => null);
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

    // 3. Clean: co-sign the exact struct hash the contract will verify.
    const hash = payStructHash({
      account: req.account,
      target: req.target,
      amount: req.amount,
      nonce: req.nonce,
      chainId: req.chainId,
    });
    const signature = await this.signer.signMessage({ message: { raw: hash } });
    return { approved: true, signature };
  }
}

/**
 * A co-signer that lives behind an HTTP endpoint — the real shape: "The Machine"
 * runs server-side (a TEE), never in the browser, so the co-signer key is never
 * exposed. The browser hands it the request; it returns a signature or a veto.
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

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: req.account,
        owner: req.owner,
        target: req.target,
        amount: req.amount.toString(),
        nonce: req.nonce.toString(),
        chainId: req.chainId.toString(),
        policy: {
          lockedTarget: req.policy.lockedTarget,
          remaining: req.policy.remaining.toString(),
          expiry: req.policy.expiry,
        },
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

