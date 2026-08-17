/**
 * Live proof, on every chain that has a router, that one-off Private Pay is ONE
 * transaction where there is no Arc precompile.
 *
 * This is the half a Foundry test cannot prove. `PrivatePayRouter.t.sol` runs
 * against a mock Permit2 and shows the router's own logic: it funds the box it
 * created, it pulls from `msg.sender`, and it refuses a reused salt before any
 * money moves. What it cannot show is that our EIP-712 encoding matches the real
 * Permit2 deployment, because the mock does not check signatures. That is exactly
 * the thing most likely to be wrong, so it is checked here against the canonical
 * Permit2 at 0x000000000022D473030F116dDEE9F6B43aC78BA3.
 *
 * Everything here is testnet. The payer, the merchant and the co-signer are the
 * repo's own demo keys.
 *
 * Run: INTEGRATION=1 vitest run test/integration/testnet.routerpay.test.ts
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
} from 'viem';
import { arbitrumSepolia, avalancheFuji, baseSepolia, sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DEPLOYMENTS,
  spendPolicyFactoryAbi,
  ownerHash as toOwnerHash,
  vaultHash as toVaultHash,
  MODE_PUSH,
  type ChainDeployment,
} from '../../src/index.js';

const RUN = process.env.INTEGRATION === '1';
const PAYER_PK = process.env.SENDER_PRIVATE_KEY as Hex | undefined;
const COSIGNER_PK = process.env.COSIGNER_PK as Hex | undefined;
const MERCHANT = process.env.RECEIVER_ADDRESS as Address | undefined;

const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3');

/**
 * How this test reaches each chain: viem's own chain definition, and a public RPC.
 *
 * The definitions are viem's rather than a minimal `{id, name}` object built here.
 * A hand-made one has no fee configuration, and on Avalanche that produced a
 * transaction with a 162 wei fee cap and a gas limit of 1.5e15, which Fuji rejected
 * as exceeding the block gas limit. Chains do not all price gas the same way, and
 * the registry that knows how is the one shipped with the client.
 *
 * Kept here rather than in the deployment registry: this is where a test signs
 * from, and the app itself reaches every non-Arc chain through the user's wallet.
 */
const CHAINS = [baseSepolia, sepolia, arbitrumSepolia, avalancheFuji];
const RPCS: Record<number, string> = {
  [baseSepolia.id]: 'https://sepolia.base.org',
  [sepolia.id]: 'https://ethereum-sepolia-rpc.publicnode.com',
  [arbitrumSepolia.id]: 'https://sepolia-rollup.arbitrum.io/rpc',
  [avalancheFuji.id]: 'https://api.avax-test.network/ext/bc/C/rpc',
};

/**
 * Every chain that claims a router, so adding one to the registry without proving
 * it works here is not possible. Arc is excluded on purpose: it has no router and
 * does this through its precompile, which `testnet.batchpay.test.ts` covers.
 */
const ROUTED = (Object.values(DEPLOYMENTS) as ChainDeployment[]).filter(
  (d) => d.privatePayRouter !== undefined && RPCS[d.chainId] !== undefined,
);

/** 0.02 USDC. Small enough to run often, large enough to be a real transfer. */
const AMOUNT = 20_000n;

const routerAbi = [
  {
    type: 'function',
    name: 'createFundAndPay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'factory', type: 'address' },
      { name: 'ownerHash', type: 'bytes32' },
      { name: 'userSalt', type: 'bytes32' },
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'cosigner', type: 'address' },
          { name: 'vaultHash', type: 'bytes32' },
          { name: 'target', type: 'address' },
          { name: 'maxAmount', type: 'uint256' },
          { name: 'perPullMax', type: 'uint256' },
          { name: 'expiry', type: 'uint40' },
          { name: 'interval', type: 'uint40' },
          { name: 'mode', type: 'uint8' },
        ],
      },
      { name: 'amount', type: 'uint256' },
      { name: 'cosignerSig', type: 'bytes' },
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'permitSig', type: 'bytes' },
    ],
    outputs: [{ name: 'account', type: 'address' }],
  },
] as const;

describe.runIf(RUN && PAYER_PK && COSIGNER_PK && MERCHANT)(
  'Private Pay in one transaction, per chain',
  () => {
    it.each(ROUTED.map((d) => [d.chain, d] as const))(
      'creates, funds and pays in a single call on %s, with the real Permit2',
      async (_name, deployment) => {
        const BASE = deployment.chainId;
        const RPC = RPCS[BASE] as string;
        const router = deployment.privatePayRouter;
        expect(router, `${deployment.chain} has no PrivatePayRouter`).toBeDefined();

        const payer = privateKeyToAccount(PAYER_PK!);
        const cosigner = privateKeyToAccount(COSIGNER_PK!);
        const usdc = getAddress(deployment.usdc);
        const factory = getAddress(deployment.spendPolicyFactory);
        const chain = CHAINS.find((c) => c.id === BASE);
        expect(chain, `no viem chain definition for ${deployment.chain}`).toBeDefined();

        // Retries on purpose: `sepolia.base.org` is load balanced, and the node
        // that hands back a receipt is not always the node that answers the next
        // call. Reads below are additionally pinned to the receipt's block, so a
        // node that has not caught up errors instead of reporting that nothing
        // happened -- which is how this test first "failed" against a payment that
        // had in fact gone through.
        const publicClient = createPublicClient({
          chain,
          transport: http(RPC, { retryCount: 6, retryDelay: 800 }),
        });
        const wallet = createWalletClient({
          account: payer,
          chain,
          transport: http(RPC),
        });

        /**
         * Send with a gas limit that is capped at something a block can hold.
         *
         * Avalanche Fuji's `eth_estimateGas` answers with what the sender can
         * afford rather than what the call costs: with a 160 wei base fee and half
         * an AVAX in hand it returned 1,555,371,120,086,116, which the node then
         * refused as exceeding the block gas limit of 32,000,000. Not a client bug
         * -- `cast send` produces the identical failure, and succeeds the moment a
         * gas limit is passed by hand.
         *
         * An estimate larger than an entire block is not an estimate of a call that
         * fits in a block, so it is clamped. Nothing is lost by clamping high: a
         * transaction is charged for gas used, not gas offered, and the node's own
         * metering still stops a call that genuinely needs more.
         */
        const send = async (request: Parameters<typeof wallet.writeContract>[0]) => {
          const [estimate, block] = await Promise.all([
            publicClient.estimateContractGas({
              account: payer,
              address: request.address as Address,
              abi: request.abi as never,
              functionName: request.functionName as never,
              args: request.args as never,
            }),
            publicClient.getBlock(),
          ]);
          const ceiling = block.gasLimit / 2n;
          return wallet.writeContract({
            ...request,
            gas: estimate > ceiling ? ceiling : estimate,
          } as never);
        };

        // The one-time prerequisite, made idempotent so the test can be rerun.
        const allowance = await publicClient.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [payer.address, PERMIT2],
        });
        if (allowance < AMOUNT) {
          const hash = await send({
            address: usdc,
            abi: erc20Abi,
            functionName: 'approve',
            args: [PERMIT2, 2n ** 160n - 1n],
          } as never);
          await publicClient.waitForTransactionReceipt({ hash });
        }

        // A fresh salt per run, so the box is always new and the co-signer's
        // nonce-zero authorisation is always the right one.
        const userSalt = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex;
        const policy = {
          token: usdc,
          owner: payer.address,
          cosigner: cosigner.address,
          vault: payer.address,
          target: getAddress(MERCHANT!),
          maxAmount: AMOUNT,
          perPullMax: 0n,
          expiry: Math.floor(Date.now() / 1000) + 3600,
          interval: 0,
          mode: MODE_PUSH,
        };
        const params = {
          token: policy.token,
          cosigner: policy.cosigner,
          vaultHash: toVaultHash(policy.vault),
          target: policy.target,
          maxAmount: policy.maxAmount,
          perPullMax: policy.perPullMax,
          expiry: policy.expiry,
          interval: policy.interval,
          mode: policy.mode,
        } as const;
        const owner = toOwnerHash(policy.owner);

        // Where the box will be. The co-signer signs for this address before any
        // code exists at it; the CREATE2 salt commits the whole policy, so this is
        // the only box that signature can ever authorise.
        const box = (await publicClient.readContract({
          address: factory,
          abi: spendPolicyFactoryAbi,
          functionName: 'predictAddress',
          args: [owner, userSalt, params],
        })) as Address;
        expect(await publicClient.getCode({ address: box })).toBeUndefined();

        const cosignerSig = await cosigner.signTypedData({
          domain: {
            name: 'Ctrl+ArcZ SpendPolicy',
            version: '1',
            chainId: BASE,
            verifyingContract: box,
          },
          types: {
            Spend: [
              { name: 'target', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'action', type: 'uint8' },
            ],
          },
          primaryType: 'Spend',
          message: { target: policy.target, amount: AMOUNT, nonce: 0n, action: 0 },
        });

        /**
         * Permit2's own EIP-712, and the reason this test exists.
         *
         * Its domain carries no `version` field, and the signed struct names the
         * spender -- so this signature is only usable by the router, and only for
         * this token, amount and deadline. The nonce is an unordered bitmap slot
         * rather than a counter, so a timestamp-derived value is a fresh one.
         */
        const nonce = BigInt(Date.now());
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
        const permitSig = await payer.signTypedData({
          domain: { name: 'Permit2', chainId: BASE, verifyingContract: PERMIT2 },
          types: {
            PermitTransferFrom: [
              { name: 'permitted', type: 'TokenPermissions' },
              { name: 'spender', type: 'address' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
            ],
            TokenPermissions: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          primaryType: 'PermitTransferFrom',
          message: {
            permitted: { token: usdc, amount: AMOUNT },
            spender: router!,
            nonce,
            deadline,
          },
        });

        const hash = await send({
          address: router!,
          abi: routerAbi,
          functionName: 'createFundAndPay',
          args: [
            factory,
            owner,
            userSalt,
            params,
            AMOUNT,
            cosignerSig,
            { permitted: { token: usdc, amount: AMOUNT }, nonce, deadline },
            permitSig,
          ],
        } as never);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe('success');

        /**
         * A read that waits for the node to have the block.
         *
         * `sepolia.base.org` is load balanced and answers `-32001 block not found`
         * for a block the particular node behind it has not imported yet. viem does
         * not retry that, because it is a valid JSON-RPC response rather than a
         * network failure -- the same shape as Arc's `-32011`, which this repo
         * already wraps in `session.ts`. Retrying only that one error keeps every
         * other failure loud.
         */
        const settled = async <T>(read: () => Promise<T>): Promise<T> => {
          for (let i = 0; ; i++) {
            try {
              return await read();
            } catch (e) {
              const message = String((e as Error)?.message ?? e);
              if (i >= 15 || !/block not found|-32001/i.test(message)) throw e;
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        };

        /** This token balance, at exactly this block. */
        const balanceAt = (who: Address, blockNumber: bigint) =>
          settled(
            () =>
              publicClient.readContract({
                address: usdc,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [who],
                blockNumber,
              }) as Promise<bigint>,
          );

        // Either side of the one block, so the difference is this payment and
        // nothing else that happened to land while the test was running.
        const merchantBefore = await balanceAt(policy.target, receipt.blockNumber - 1n);
        const merchantAfter = await balanceAt(policy.target, receipt.blockNumber);
        expect(merchantAfter - merchantBefore).toBe(AMOUNT);

        const payerBefore = await balanceAt(payer.address, receipt.blockNumber - 1n);
        const payerAfter = await balanceAt(payer.address, receipt.blockNumber);
        expect(payerBefore - payerAfter).toBe(AMOUNT);

        // One transaction did all three things: the box exists now and did not
        // before, and it paid out everything it was given.
        expect(
          await settled(() =>
            publicClient.getCode({ address: box, blockNumber: receipt.blockNumber }),
          ),
        ).toBeDefined();
        expect(await balanceAt(box, receipt.blockNumber)).toBe(0n);
        // The router is a route, never a holder. Anything left here would be
        // anyone's to take.
        expect(await balanceAt(router!, receipt.blockNumber)).toBe(0n);
      },
      180_000,
    );
  },
);
