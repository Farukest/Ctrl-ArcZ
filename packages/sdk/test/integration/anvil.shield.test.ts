/**
 * On-chain cross-check for the payer-side shield against a local anvil.
 *
 * This is the authoritative end-to-end proof that the SDK's digest + owner
 * signature + co-signer signature are accepted by the deployed
 * `SpendPolicyAccount` — i.e. the TS and Solidity sides agree byte-for-byte on a
 * real EVM. Excluded from the default unit run (lives under integration/); start
 * anvil first:  wsl ~/.foundry/bin/anvil --host 0.0.0.0
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createEphemeral, readAccount, settlePrivatePayment, MODE_PUSH } from '../../src/shield/shield.js';
import { LocalCoSigner, type RiskVerdict } from '../../src/shield/cosigner.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN = {
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

// anvil default accounts
const OWNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const COSIGNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const MERCHANT = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const VAULT = getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906');

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(here, '../../../contracts/out');
function artifact(name: string): { abi: unknown; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`${artifacts}/${name}.sol/${name}.json`, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

const owner = privateKeyToAccount(OWNER_PK);
const cosignerAccount = privateKeyToAccount(COSIGNER_PK);

let publicClient: PublicClient;
let walletClient: WalletClient;
let usdc: Address;
let factory: Address;
let reachable = false;

async function deploy(name: string, args: unknown[] = []): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await walletClient.deployContract({
    abi: abi as never,
    bytecode,
    args: args as never,
    account: owner,
    chain: CHAIN,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`no address for ${name}`);
  return receipt.contractAddress;
}

async function mint(to: Address, amount: bigint): Promise<void> {
  const { abi } = artifact('MockUSDC');
  const hash = await walletClient.writeContract({
    address: usdc,
    abi: abi as never,
    functionName: 'mint',
    args: [to, amount],
    account: owner,
    chain: CHAIN,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function balanceOf(who: Address): Promise<bigint> {
  const { abi } = artifact('MockUSDC');
  return publicClient.readContract({ address: usdc, abi: abi as never, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
}

beforeAll(async () => {
  publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  walletClient = createWalletClient({ account: owner, chain: CHAIN, transport: http(RPC) });
  try {
    await publicClient.getChainId();
    reachable = true;
  } catch {
    reachable = false;
    return;
  }
  usdc = await deploy('MockUSDC');
  factory = await deploy('SpendPolicyFactory');
});

describe('shield on-chain cross-check (anvil)', () => {
  it('a clean private payment settles: SDK signatures are accepted by the contract', async () => {
    if (!reachable) return expect(reachable, 'anvil not reachable at 127.0.0.1:8545 — skipping').toBe(true);

    const salt = ('0x' + '11'.padStart(64, '0')) as Hex;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const { account } = await createEphemeral({ publicClient, walletClient }, factory, salt, {
      token: usdc,
      owner: owner.address,
      cosigner: cosignerAccount.address,
      vault: VAULT,
      target: MERCHANT,
      maxAmount: 100_000_000n,
      expiry,
      interval: 0,
      mode: MODE_PUSH,
    });

    await mint(account, 100_000_000n); // fund the ephemeral address

    const safe: RiskVerdict = { level: 'safe', complete: true };
    const cosigner = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => safe });

    const before = await balanceOf(MERCHANT);
    const outcome = await settlePrivatePayment({ publicClient, walletClient }, account, 50_000_000n, cosigner, {
      owner: owner.address,
      vault: VAULT,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

    const after = await balanceOf(MERCHANT);
    expect(after - before).toBe(50_000_000n);

    const state = await readAccount(publicClient, account);
    expect(state.spent).toBe(50_000_000n);
    expect(state.nonce).toBe(1n);
  });

  it('a blocked target is vetoed: the co-signer withholds its signature, no funds move', async () => {
    if (!reachable) return expect(reachable, 'anvil not reachable — skipping').toBe(true);

    const salt = ('0x' + '22'.padStart(64, '0')) as Hex;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const { account } = await createEphemeral({ publicClient, walletClient }, factory, salt, {
      token: usdc,
      owner: owner.address,
      cosigner: cosignerAccount.address,
      vault: VAULT,
      target: MERCHANT,
      maxAmount: 100_000_000n,
      expiry,
      interval: 0,
      mode: MODE_PUSH,
    });
    await mint(account, 100_000_000n);

    const blocked: RiskVerdict = { level: 'block', complete: true, reasons: ['known drainer'] };
    const cosigner = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => blocked });

    const before = await balanceOf(MERCHANT);
    const outcome = await settlePrivatePayment({ publicClient, walletClient }, account, 50_000_000n, cosigner, {
      owner: owner.address,
      vault: VAULT,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.vetoed).toBe(true);

    const after = await balanceOf(MERCHANT);
    expect(after).toBe(before); // nothing moved
    const state = await readAccount(publicClient, account);
    expect(state.spent).toBe(0n);
  });
});
