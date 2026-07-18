import type { IncomingMessage, ServerResponse } from 'node:http';
import { cosign, cosignerAddress } from '@ctrl-arcz/demo-kit/cosign';
import { bridgeUsdc } from '@ctrl-arcz/demo-kit/cctp';
import { gatewayTransfer } from '@ctrl-arcz/demo-kit/gateway';
import { gaslessClaimToResult } from '@ctrl-arcz/demo-kit/gasless';
import { env } from './env.js';
import { json, readJson, HttpError } from './http.js';

const BRIDGE_CHAIN_IDS = new Set([
  'Arc_Testnet',
  'Ethereum_Sepolia',
  'Base_Sepolia',
  'Arbitrum_Sepolia',
  'Optimism_Sepolia',
  'Avalanche_Fuji',
  'Polygon_Amoy_Testnet',
  'Unichain_Sepolia',
  'Linea_Sepolia',
  'Sonic_Testnet',
  'World_Chain_Sepolia',
]);
const GATEWAY_CHAIN_IDS = new Set([
  'Arc_Testnet',
  'Ethereum_Sepolia',
  'Base_Sepolia',
  'Avalanche_Fuji',
  'Sonic_Testnet',
]);
const MAX_BRIDGE_AMOUNT = 5; // USDC, testnet demo ceiling

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

// --- cross-chain (shared validation for CCTP + Gateway) ---

function parseCrossChain(body: unknown, allowed: Set<string>) {
  const { from, to, amount } = (body ?? {}) as { from?: unknown; to?: unknown; amount?: unknown };
  if (typeof from !== 'string' || !allowed.has(from)) throw new HttpError(400, 'invalid source chain');
  if (typeof to !== 'string' || !allowed.has(to)) throw new HttpError(400, 'invalid destination chain');
  if (from === to) throw new HttpError(400, 'source and destination must differ');
  const amt = typeof amount === 'string' || typeof amount === 'number' ? Number(amount) : NaN;
  if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_BRIDGE_AMOUNT) throw new HttpError(400, 'invalid amount');
  return { from, to, amount: String(amount) };
}

export async function bridgePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.relayerPk) throw new HttpError(400, 'no relayer key configured');
  const { from, to, amount } = parseCrossChain(await readJson(req), BRIDGE_CHAIN_IDS);
  const result = await bridgeUsdc({ privateKey: env.relayerPk, from, to, amount } as never);
  json(res, 200, result);
}

export async function gatewayPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.relayerPk) throw new HttpError(400, 'no relayer key configured');
  const { from, to, amount } = parseCrossChain(await readJson(req), GATEWAY_CHAIN_IDS);
  const result = await gatewayTransfer({ privateKey: env.relayerPk, from, to, amount } as never);
  json(res, 200, result);
}

// --- gasless claim (Circle Gas Station) ---

export async function gaslessPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.relayerPk) throw new HttpError(400, 'gasless not configured');
  const { transferId, code, salt } = (await readJson(req)) as {
    transferId?: unknown;
    code?: unknown;
    salt?: unknown;
  };
  if (typeof transferId !== 'string' || !/^\d{1,78}$/.test(transferId)) throw new HttpError(400, 'invalid transferId');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new HttpError(400, 'invalid code');
  if (typeof salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new HttpError(400, 'invalid salt');

  const cfg = {
    clientKey: env.circleClientKey,
    clientUrl: env.circleClientUrl,
    ownerKey: env.relayerPk,
  };
  const result = await gaslessClaimToResult(cfg as never, BigInt(transferId), code, salt as `0x${string}`);
  json(res, 200, result);
}
