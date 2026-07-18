/**
 * Real Arc Testnet end-to-end for the payer-side shield, against the DEPLOYED
 * contracts. This is the authoritative proof that the Arc-specific path works:
 * on Arc a USDC ERC-20 transfer moves native balance, so funding/sweeping a
 * contract requires `receive()` — a thing anvil's plain MockUSDC cannot surface.
 *
 * Spends a few cents of testnet USDC. Gated on INTEGRATION=1 and the env keys.
 * Run: INTEGRATION=1 vitest run test/integration/testnet.shield.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  getAddress,
  type Address,
  type Hex,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  arcTestnet,
  RPC_URL,
  ADDRESSES,
  SPEND_POLICY_FACTORY_ADDRESS,
  SHIELD_VAULT_ADDRESS,
} from '../../src/chains/arcTestnet.js';
import { createEphemeral, readAccount, settlePrivatePayment, sweepToVault, MODE_PUSH } from '../../src/shield/shield.js';
import { LocalCoSigner, type RiskVerdict } from '../../src/shield/cosigner.js';

const RUN = process.env.INTEGRATION === '1';
const OWNER_PK = process.env.SENDER_PRIVATE_KEY as Hex | undefined;
const COSIGNER_PK = process.env.COSIGNER_PK as Hex | undefined;
const MERCHANT = process.env.RECEIVER_ADDRESS as Address | undefined;

const USDC = getAddress(ADDRESSES.USDC);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The public Arc RPC returns JSON-RPC error -32011 "request limit reached" under
 * load, which viem does NOT retry (it is not a 5xx/timeout). Wrap the transport
 * to back off and retry on exactly that, so a rate-limit blip does not fail the
 * end-to-end proof.
 */
function rateLimitedHttp(url: string): Transport {
  const inner = http(url, { retryCount: 6, retryDelay: 1200, timeout: 30_000 });
  return ((params) => {
    const t = inner(params);
    const request = async (args: unknown, opts?: unknown) => {
      for (let i = 0; ; i++) {
        try {
          return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts);
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          if (i < 25 && /request limit|rate limit|429|-32011/i.test(msg)) {
            await sleep(2000);
            continue;
          }
          throw e;
        }
      }
    };
    return { ...t, request } as typeof t;
  }) as Transport;
}
const transport = rateLimitedHttp(RPC_URL);

describe.runIf(RUN && OWNER_PK && COSIGNER_PK && MERCHANT)('shield on Arc Testnet (deployed)', () => {
  it('funds a fresh ephemeral (native-value path), pays the merchant, sweeps home', async () => {
    const owner = privateKeyToAccount(OWNER_PK!);
    const cosignerAccount = privateKeyToAccount(COSIGNER_PK!);
    const merchant = getAddress(MERCHANT!);
    // High pollingInterval keeps receipt polling from hammering the rate-limited
    // public RPC; sleeps between phases let the request window recover.
    const publicClient = createPublicClient({ chain: arcTestnet, transport, pollingInterval: 5000 });
    const walletClient = createWalletClient({ account: owner, chain: arcTestnet, transport });
    const clients = { publicClient, walletClient };

    const balanceOf = (who: Address) =>
      publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

    const MAX = 50_000n; // 0.05 USDC
    const FUND = 30_000n; // 0.03
    const PAY = 20_000n; // 0.02
    const salt = ('0x' + Date.now().toString(16).padStart(64, '0')) as Hex; // unique per run
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    // 1. create the disposable account (locked to the merchant)
    const { account } = await createEphemeral(clients, SPEND_POLICY_FACTORY_ADDRESS, salt, {
      token: USDC,
      owner: owner.address,
      cosigner: cosignerAccount.address,
      vault: SHIELD_VAULT_ADDRESS,
      target: merchant,
      maxAmount: MAX,
      expiry,
      interval: 0,
      mode: MODE_PUSH,
    });
    await sleep(3000);

    // 2. fund it — a USDC transfer to the deployed clone, which on Arc moves native
    //    value and only succeeds because the account has receive().
    const fundHash = await walletClient.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [account, FUND],
      account: owner,
      chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    await sleep(3000);
    expect(await balanceOf(account)).toBe(FUND);
    await sleep(2000);

    // 3. private payment: co-signer (safe stub here; firewall veto is unit-tested) + owner
    const safe: RiskVerdict = { level: 'safe', complete: true };
    const cosigner = new LocalCoSigner(COSIGNER_PK!, { riskCheck: async () => safe });

    const before = await balanceOf(merchant);
    const outcome = await settlePrivatePayment(clients, account, PAY, cosigner, {
      owner: owner.address,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect((await balanceOf(merchant)) - before).toBe(PAY);

    const state = await readAccount(publicClient, account);
    expect(state.spent).toBe(PAY);
    await sleep(2000);

    // 4. sweep the remainder home to the vault — receive() on the Vault too.
    const vaultBefore = await balanceOf(SHIELD_VAULT_ADDRESS);
    await sweepToVault(clients, account, SHIELD_VAULT_ADDRESS);
    expect((await balanceOf(SHIELD_VAULT_ADDRESS)) - vaultBefore).toBe(FUND - PAY);
    expect(await balanceOf(account)).toBe(0n);
  }, 180_000);
});
