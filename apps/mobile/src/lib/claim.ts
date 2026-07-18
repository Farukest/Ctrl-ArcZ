import { registerConfig, defineConfig } from '@ctrl-arcz/sdk';
import type { Hex } from 'viem';
import type { WalletSession } from './wallet';

/**
 * The claim payload a QR carries: the on-chain transfer id, the human 6-digit
 * code, and the secret salt. The recipient scans it and calls `claim`. (The code
 * can also be shared out-of-band; the QR is the convenience path.)
 */
export interface ClaimPayload {
  transferId: bigint;
  code: string;
  salt: Hex;
}

export function encodeClaim(p: ClaimPayload): string {
  return JSON.stringify({ v: 1, t: p.transferId.toString(), c: p.code, s: p.salt });
}

export function decodeClaim(data: string): ClaimPayload | null {
  try {
    const o = JSON.parse(data) as { t?: unknown; c?: unknown; s?: unknown };
    if (typeof o.t === 'string' && typeof o.c === 'string' && typeof o.s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(o.s)) {
      return { transferId: BigInt(o.t), code: o.c, salt: o.s as Hex };
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
