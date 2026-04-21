/**
 * Derives `packages/contracts/addresses.arc-testnet.json` from the single source
 * of truth, `packages/sdk/src/chains/arcTestnet.ts`.
 *
 * Foundry cannot import TypeScript, and no address may be hardcoded twice, so the
 * Solidity deploy script reads this generated file instead of carrying its own
 * copy of the addresses. Run before `forge script`; `pnpm deploy:testnet` does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'packages/sdk/src/chains/arcTestnet.ts');
const outPath = path.join(root, 'packages/contracts/addresses.arc-testnet.json');

const ts = fs.readFileSync(sourcePath, 'utf8');

const addressBlock = ts.split('export const ADDRESSES')[1]?.split('} as const')[0];
if (!addressBlock) throw new Error(`ADDRESSES block not found in ${sourcePath}`);

const addresses = Object.fromEntries(
  [...addressBlock.matchAll(/(\w+):\s*'(0x[0-9a-fA-F]{40})'/g)].map((m) => [m[1], m[2]]),
);

const chainId = Number(ts.match(/ARC_TESTNET_CHAIN_ID\s*=\s*(\d+)/)?.[1]);
const rpcUrl = ts.match(/RPC_URL\s*=\s*'([^']+)'/)?.[1];

if (!addresses.USDC) throw new Error('USDC address missing');
if (!chainId) throw new Error('chain id missing');

const out = {
  _generated: 'DO NOT EDIT — generated from packages/sdk/src/chains/arcTestnet.ts',
  chainId,
  rpcUrl,
  ...addresses,
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`addresses.arc-testnet.json yazildi (chainId ${chainId}, USDC ${addresses.USDC})`);
