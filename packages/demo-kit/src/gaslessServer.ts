import { createPublicClient, http, type Hex } from 'viem';
import {
  claim,
  deploymentFor,
  getTransfer,
  hashClaim,
  arcTestnet,
  ARC_TESTNET_CHAIN_ID,
  RPC_URL,
  TransferLockedError,
  TransferUnavailableError,
  WrongClaimCodeError,
  type TransferUnavailableReason,
} from '@ctrl-arcz/sdk';
import {
  circleGaslessClaim,
  circleGaslessEnabled,
  type CircleGaslessInput,
} from './circleGasless.js';
import { localSigner, signerFor } from './session.js';

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

/** Whether (salt, code) satisfies the transfer's on-chain claimHash. Pure; used to
 *  reject a wrong code BEFORE spending a sponsored/relayer transaction, so an
 *  unauthenticated caller cannot burn the transfer's 5-attempt lockout budget. */
export function codeMatchesClaimHash(claimHash: Hex, salt: Hex, code: string): boolean {
  return hashClaim(salt, code).toLowerCase() === claimHash.toLowerCase();
}

/**
 * Server-only. Runs a gasless claim (Circle Gas Station if configured, else a
 * relayer-signed claim) and returns a plain, serializable result instead of
 * throwing across the HTTP boundary. This is what a `/api/gasless-claim` endpoint
 * calls, so the relayer/Circle keys stay on the server and never reach the browser.
 */
export interface GaslessClaimResult {
  ok: boolean;
  txHash?: string;
  error?: {
    kind: 'wrong_code' | 'locked' | 'unavailable' | 'unknown';
    attemptsRemaining?: number;
    reason?: TransferUnavailableReason;
    message?: string;
  };
}

/**
 * Circle's Modular Wallets SDK reads `window.location` (client keys are
 * domain-bound). On the server there is no `window`, so provide a minimal shim
 * matching the demo's origin. No-op in the browser, where `window` already exists.
 */
function ensureWindowShim(): void {
  const g = globalThis as { window?: unknown };
  if (!g.window) {
    g.window = {
      location: {
        hostname: 'localhost',
        protocol: 'http:',
        host: 'localhost:5174',
        href: 'http://localhost:5174/',
        origin: 'http://localhost:5174',
      },
    };
  }
}

export async function gaslessClaimToResult(
  cfg: CircleGaslessInput,
  transferId: bigint,
  code: string,
  salt: Hex,
  /**
   * Which chain the transfer is on. Arc testnet when absent, so a client written
   * before mainnet keeps working unchanged.
   */
  chainId: number = ARC_TESTNET_CHAIN_ID,
): Promise<GaslessClaimResult> {
  ensureWindowShim();
  const onTestnetArc = chainId === ARC_TESTNET_CHAIN_ID;
  const deployment = deploymentFor(chainId);
  if (!deployment) {
    return { ok: false, error: { kind: 'unknown', message: `no deployment on chain ${chainId}` } };
  }
  /*
   * Anywhere but testnet Arc the claim is the relayer's own transaction. Circle's
   * Gas Station sponsors testnet automatically; on mainnet it needs a policy that
   * is created, activated and billed in the Console, and this deployment has none.
   * The relayer paying is the same fallback testnet Arc uses without a client key.
   */
  const pair = onTestnetArc || !cfg.ownerKey ? null : signerFor(chainId, cfg.ownerKey);
  const reader = pair ? pair.publicClient : publicClient;
  try {
    // Pre-flight: reject a wrong code off-chain so it never consumes an on-chain
    // claim attempt (closes the free lock-griefing). A failed read falls through to
    // the on-chain path, which is itself attempt-limited.
    try {
      const transfer = await getTransfer(
        { publicClient: reader, contractAddress: deployment.ctrlArcZ },
        transferId,
      );
      if (!codeMatchesClaimHash(transfer.claimHash, salt, code)) {
        return { ok: false, error: { kind: 'wrong_code' } };
      }
    } catch {
      // could not read the transfer; let the on-chain claim be the arbiter
    }

    let txHash: string;
    if (!onTestnetArc) {
      if (!pair) return { ok: false, error: { kind: 'unknown', message: 'gasless not configured' } };
      txHash = await claim({ ...pair, contractAddress: deployment.ctrlArcZ }, transferId, code, salt);
    } else if (circleGaslessEnabled(cfg)) {
      txHash = await circleGaslessClaim(cfg, transferId, code, salt);
    } else if (cfg.ownerKey) {
      // Fallback: the relayer signs and pays gas itself (recipient still pays 0).
      txHash = await claim(localSigner(cfg.ownerKey), transferId, code, salt);
    } else {
      return { ok: false, error: { kind: 'unknown', message: 'gasless not configured' } };
    }
    return { ok: true, txHash };
  } catch (e) {
    if (e instanceof WrongClaimCodeError) {
      return { ok: false, error: { kind: 'wrong_code', attemptsRemaining: e.attemptsRemaining } };
    }
    if (e instanceof TransferLockedError) {
      return { ok: false, error: { kind: 'locked' } };
    }
    if (e instanceof TransferUnavailableError) {
      return { ok: false, error: { kind: 'unavailable', reason: e.reason } };
    }
    // Do not leak internal SDK/RPC/bundler detail to the client; log it server-side.
    console.error('gasless claim failed:', e instanceof Error ? e.message : e);
    return { ok: false, error: { kind: 'unknown', message: 'gasless claim failed' } };
  }
}
