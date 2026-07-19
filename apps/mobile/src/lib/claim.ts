import { registerConfig, defineConfig } from '@ctrl-arcz/sdk';
import type { Hex } from 'viem';
import type { WalletSession } from './wallet';

/**
 * The claim reference a QR carries: the on-chain transfer id and the secret salt,
 * but NOT the 6-digit code. The code is a second factor and must be shared out of
 * band (spoken, texted), so a photographed or shoulder-surfed QR alone cannot
 * claim. The recipient scans this, then enters the code to call `claim`.
 */
export interface ClaimPayload {
  transferId: bigint;
  salt: Hex;
}

export function encodeClaim(p: ClaimPayload): string {
  return JSON.stringify({ v: 2, t: p.transferId.toString(), s: p.salt });
}

export function decodeClaim(data: string): ClaimPayload | null {
  try {
    const o = JSON.parse(data) as { t?: unknown; s?: unknown };
    if (typeof o.t === 'string' && typeof o.s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(o.s)) {
      return { transferId: BigInt(o.t), salt: o.s as Hex };
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
