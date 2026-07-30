import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ADDRESSES,
  MODE_PULL,
  RPC_URLS,
  SPEND_POLICY_FACTORY_ADDRESS,
  arcTestnet,
  createEphemeral,
} from '@ctrl-arcz/sdk';

/**
 * Create and fund the keeper's salary box.
 *
 * The box is what makes the keeper safe to run unattended. Its policy is written
 * on chain at creation and cannot be edited afterwards:
 *
 *   target  = the keeper        the money can only ever go to the keeper
 *   vault   = the operator      leftovers can only ever come back to you
 *   owner   = the keeper        so the keeper can authenticate its own pulls
 *   perPull = a daily ceiling   the most a compromised keeper gets per interval
 *   cap     = a total budget    the most it can ever cost you
 *
 * Revoking is `sweepToVault` from the operator's wallet — a call gated on
 * `msg.sender == vault`, so the keeper cannot make it and cannot stop you.
 *
 *   OPERATOR_PK=0x... KEEPER_PK=0x... pnpm --filter @ctrl-arcz/keeper exec \
 *     tsx scripts/create-salary-box.ts
 */

const USDC = ADDRESSES.USDC as Address;

function key(name: string): Hex {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  const k = (v.startsWith('0x') ? v : `0x${v}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte hex key`);
  return k;
}

const operator = privateKeyToAccount(key('OPERATOR_PK'));
const keeper = privateKeyToAccount(key('KEEPER_PK'));

const perPull = process.env.SALARY_PER_PULL ?? '0.50';
const total = process.env.SALARY_TOTAL ?? '5.00';
const intervalSecs = Number(process.env.SALARY_INTERVAL_SECS ?? 86_400);
const durationSecs = Number(process.env.SALARY_DURATION_SECS ?? 90 * 86_400);
const cosignUrl = process.env.KEEPER_COSIGN_URL ?? 'http://127.0.0.1:8787/api/cosign';

const transport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 2 })));
const publicClient = createPublicClient({ chain: arcTestnet, transport: transport() });
const walletClient = createWalletClient({ account: operator, chain: arcTestnet, transport: transport() });
const clients = { publicClient, walletClient };

const cosignerRes = await fetch(cosignUrl);
if (!cosignerRes.ok) throw new Error(`co-signer unreachable at ${cosignUrl} (${cosignerRes.status})`);
const { address: cosigner } = (await cosignerRes.json()) as { address: Address };
if (!isAddress(cosigner)) throw new Error('co-signer returned no address');

const perPullAmt = parseUnits(perPull, 6);
const totalAmt = parseUnits(total, 6);

const salt = (() => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}` as Hex;
})();

console.log(`operator (vault): ${operator.address}`);
console.log(`keeper (owner + target): ${keeper.address}`);
console.log(`co-signer: ${cosigner}`);
console.log(`policy: ${perPull} USDC per pull, every ${intervalSecs}s, ${total} USDC total`);

const { account: box } = await createEphemeral(clients, SPEND_POLICY_FACTORY_ADDRESS, salt, {
  token: USDC,
  owner: keeper.address, // the keeper authenticates its own pulls to the co-signer
  cosigner,
  vault: operator.address, // leftovers can only ever return here
  target: keeper.address, // and outbound can only ever reach here
  maxAmount: totalAmt,
  perPullMax: perPullAmt,
  expiry: Math.floor(Date.now() / 1000) + durationSecs,
  interval: intervalSecs,
  mode: MODE_PULL,
});

console.log(`\nbox created: ${box}`);

const fundHash = await walletClient.writeContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [box, totalAmt],
  account: operator,
  chain: arcTestnet,
});
await publicClient.waitForTransactionReceipt({ hash: fundHash });

const funded = (await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [box],
})) as bigint;

console.log(`funded with ${formatUnits(funded, 6)} USDC (${fundHash})`);
console.log(`\nAdd to apps/keeper/.env:\n  KEEPER_SALARY_BOX=${box}`);
console.log(`\nTo revoke and take the remainder back, sweep it from ${operator.address}.`);
