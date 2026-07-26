/**
 * Live Arc proof that Private Pay's three steps (create box + fund + pay) collapse
 * into ONE transaction, one signature, via Multicall3. The co-signer signs for the
 * COUNTERFACTUAL box (its predicted address, nonce 0) because the CREATE2 salt binds
 * the full policy to the address, so the box that will exist can only be this one.
 *
 * Funding is a native-value send to the box's receive() (on Arc native == USDC, but
 * native is 18-dec vs the ERC-20 6-dec interface, so the value is scaled by 1e12).
 *
 * Run: INTEGRATION=1 vitest run test/integration/testnet.batchpay.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  erc20Abi,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  arcTestnet,
  RPC_URLS,
  ADDRESSES,
  SPEND_POLICY_FACTORY_ADDRESS,
  spendPolicyFactoryAbi,
  spendPolicyAccountAbi,
  predictEphemeral,
  ownerHash as toOwnerHash,
  vaultHash as toVaultHash,
  LocalCoSigner,
  MODE_PUSH,
  ACTION_PAY,
  type RiskVerdict,
} from '../../src/index.js';

const RUN = process.env.INTEGRATION === '1';
const PK = process.env.SENDER_PRIVATE_KEY as Hex | undefined;
const COSIGNER_PK = process.env.COSIGNER_PK as Hex | undefined;
const RECEIVER_PK = process.env.RECEIVER_PRIVATE_KEY as Hex | undefined;

const MULTICALL3 = getAddress(ADDRESSES.MULTICALL3);
const USDC = getAddress(ADDRESSES.USDC);
const multicall3Abi = [
  {
    type: 'function',
    name: 'aggregate3Value',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

const transport = fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500, timeout: 30_000 })));

describe.runIf(RUN && PK && COSIGNER_PK)('batched private pay on Arc Testnet (one tx)', () => {
  it('create + fund + pay in a single Multicall3 transaction', async () => {
    const payer = privateKeyToAccount(PK!);
    const cosignerAccount = privateKeyToAccount(COSIGNER_PK!);
    const merchant = RECEIVER_PK ? privateKeyToAccount(RECEIVER_PK).address : cosignerAccount.address;

    const publicClient = createPublicClient({ chain: arcTestnet, transport, pollingInterval: 5000 });
    const walletClient = createWalletClient({ account: payer, chain: arcTestnet, transport });
    const balanceOf = (who: Address) =>
      publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;

    const amt6 = 20_000n; // 0.02 USDC (ERC-20 6-dec)
    const nativeValue = amt6 * 10n ** 12n; // same amount as native (18-dec) for the funding send
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const salt = ('0x' + Date.now().toString(16).padStart(64, '0')) as Hex;

    const policy = {
      token: USDC,
      owner: payer.address,
      cosigner: cosignerAccount.address,
      vault: payer.address,
      target: getAddress(merchant),
      maxAmount: amt6,
      perPullMax: 0n,
      expiry,
      interval: 0,
      mode: MODE_PUSH,
    } as const;

    // 1. Predict the box address (it does not exist yet).
    const box = await predictEphemeral(publicClient, SPEND_POLICY_FACTORY_ADDRESS, salt, policy);
    const chainId = await publicClient.getChainId();

    // 2. Co-sign for the counterfactual box (nonce 0). Safe: the salt commits the
    //    policy to `box`, so a box at that address can only be this exact one.
    const safe: RiskVerdict = { level: 'safe', complete: true };
    const cosigner = new LocalCoSigner(COSIGNER_PK!, { riskCheck: async () => safe });
    const auth = await cosigner.authorize({
      account: box,
      owner: payer.address,
      amount: amt6,
      action: ACTION_PAY,
      target: policy.target,
      nonce: 0n,
      chainId,
      remaining: amt6,
      expiry,
    });
    expect(auth.approved, JSON.stringify(auth)).toBe(true);

    // 3. One Multicall3 tx: createAccount -> fund (native value to receive()) -> pay.
    const createData = encodeFunctionData({
      abi: spendPolicyFactoryAbi,
      functionName: 'createAccount',
      args: [
        toOwnerHash(payer.address),
        salt,
        {
          token: USDC,
          cosigner: cosignerAccount.address,
          vaultHash: toVaultHash(payer.address),
          target: policy.target,
          maxAmount: amt6,
          perPullMax: 0n,
          expiry,
          interval: 0,
          mode: MODE_PUSH,
        },
      ],
    });
    const payData = encodeFunctionData({
      abi: spendPolicyAccountAbi,
      functionName: 'pay',
      args: [amt6, (auth as { signature: Hex }).signature],
    });

    const before = await balanceOf(policy.target);
    const hash = await walletClient.writeContract({
      address: MULTICALL3,
      abi: multicall3Abi,
      functionName: 'aggregate3Value',
      args: [
        [
          { target: SPEND_POLICY_FACTORY_ADDRESS, allowFailure: false, value: 0n, callData: createData },
          { target: box, allowFailure: false, value: nativeValue, callData: '0x' as Hex },
          { target: box, allowFailure: false, value: 0n, callData: payData },
        ],
      ],
      value: nativeValue,
      account: payer,
      chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    // The merchant received exactly the amount, all from one tx.
    expect((await balanceOf(policy.target)) - before).toBe(amt6);
  }, 180_000);
});
