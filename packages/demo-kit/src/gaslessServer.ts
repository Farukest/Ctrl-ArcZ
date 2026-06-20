import type { Hex } from 'viem';
import {
  claim,
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
import { localSigner } from './session.js';

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
): Promise<GaslessClaimResult> {
  ensureWindowShim();
  try {
    let txHash: string;
    if (circleGaslessEnabled(cfg)) {
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
    return {
      ok: false,
      error: { kind: 'unknown', message: e instanceof Error ? e.message : String(e) },
    };
  }
}
