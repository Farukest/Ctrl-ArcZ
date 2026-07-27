import { registerConfig, defineConfig } from '@ctrl-arcz/sdk';
import type { Hex } from 'viem';
import type { WalletSession } from './wallet';

/**
 * The claim reference a QR carries: only which transfer to open. No part of the
 * claim secret is in it. A QR can be photographed or shoulder-surfed, and under the
 * single-secret scheme the secret is the whole credential, so it never rides along:
 * the sender hands it over themselves and the recipient types it.
 */
export interface ClaimPayload {
  transferId: bigint;
}

export function encodeClaim(p: ClaimPayload): string {
  return JSON.stringify({ v: 3, t: p.transferId.toString() });
}

export function decodeClaim(data: string): ClaimPayload | null {
  try {
    const o = JSON.parse(data) as { t?: unknown };
    if (typeof o.t === 'string' && /^\d+$/.test(o.t)) {
      return { transferId: BigInt(o.t) };
    }
  } catch {
    // not our payload
  }
  return null;
}

// Register one integrator config per app session and reuse it across sends.
let cachedConfigId: Hex | null = null;

export async function getConfigId(session: WalletSession): Promise<Hex> {
  if (cachedConfigId) return cachedConfigId;
  const { configId } = await registerConfig(
    { publicClient: session.publicClient, walletClient: session.walletClient },
    defineConfig({ recallWindow: 3600 }),
  );
  cachedConfigId = configId;
  return configId;
}
