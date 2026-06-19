import { createPublicClient, type Hash, type Hex, type Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBundlerClient } from 'viem/account-abstraction';
import { arcTestnet } from 'viem/chains';
import {
  toCircleSmartAccount,
  toModularTransport,
  getUserOperationGasPrice,
} from '@circle-fin/modular-wallets-core';
import {
  CTRL_ARCZ_ADDRESS,
  encodeClaimCall,
  getTransfer,
  interpretClaimReceipt,
  TransferLockedError,
  TransferUnavailableError,
} from '@ctrl-arcz/sdk';

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hash;

export interface CircleGaslessConfig {
  /** Circle Modular Wallets client key, e.g. `TEST_CLIENT_KEY:<id>:<secret>`. */
  clientKey: string;
  /** Circle client URL, e.g. `https://modular-sdk.circle.com/v1/rpc/w3s/buidl`. */
  clientUrl: string;
  /** Private key that owns the sponsoring smart account (a relayer key). */
  ownerKey: `0x${string}`;
}

/** Loose input (env vars may be undefined) for the enabled-check. */
export interface CircleGaslessInput {
  clientKey?: string | undefined;
  clientUrl?: string | undefined;
  ownerKey?: `0x${string}` | undefined;
}

/** True (and narrows the type) when Circle gasless is fully configured. */
export function circleGaslessEnabled(cfg: CircleGaslessInput): cfg is CircleGaslessConfig {
  return Boolean(cfg.clientKey && cfg.clientUrl && cfg.ownerKey);
}

/**
 * Claims a protected transfer with **zero gas for the recipient**, using a Circle
 * Smart Account whose gas is sponsored by Circle Gas Station (`paymaster: true`).
 *
 * The contract releases funds to the transfer's *recorded* recipient, never to
 * `msg.sender`, so the sponsoring smart account is only a relayer — it cannot
 * redirect the funds. Returns the same typed outcomes as `claim()` (a wrong code
 * throws `WrongClaimCodeError`, an already-settled transfer `TransferUnavailableError`,
 * etc.) by parsing the user-operation receipt through the SDK's shared interpreter.
 */
export async function circleGaslessClaim(
  cfg: CircleGaslessConfig,
  transferId: bigint,
  code: string,
  salt: Hex,
): Promise<Hash> {
  const transport = toModularTransport(`${cfg.clientUrl}/arcTestnet`, cfg.clientKey);
  const client = createPublicClient({ chain: arcTestnet, transport });

  // Pre-flight: never spend a sponsored user-operation on a transfer that cannot
  // be claimed (already claimed/cancelled, locked, or unknown). A raw bundler
  // revert would otherwise leak to the user; this returns a clean typed error.
  const t = await getTransfer({ publicClient: client }, transferId);
  if (t.status === 'LOCKED') throw new TransferLockedError(transferId, ZERO_HASH);
  if (t.status !== 'PENDING') {
    throw new TransferUnavailableError(t.status === 'NONE' ? 'unknown' : 'not_pending');
  }

  const owner = privateKeyToAccount(cfg.ownerKey);
  const account = await toCircleSmartAccount({ client, owner });
  const bundlerClient = createBundlerClient({ account, chain: arcTestnet, transport });

  // Circle's bundler requires its own gas-price quote (viem's estimate is rejected).
  const gas = await getUserOperationGasPrice(bundlerClient);

  let userOpHash: Hex;
  try {
    userOpHash = await bundlerClient.sendUserOperation({
      calls: [{ to: CTRL_ARCZ_ADDRESS, data: encodeClaimCall(transferId, code, salt) }],
      paymaster: true,
      maxFeePerGas: BigInt(gas.medium.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(gas.medium.maxPriorityFeePerGas),
    });
  } catch (e) {
    // A revert here means the transfer was settled between the check and submit
    // (a wrong code does NOT revert — it mines and is read from the receipt).
    const msg = e instanceof Error ? e.message : String(e);
    if (/revert/i.test(msg)) throw new TransferUnavailableError('not_pending');
    throw e;
  }

  const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
  return interpretClaimReceipt(
    receipt.logs as Log[],
    CTRL_ARCZ_ADDRESS,
    transferId,
    receipt.transactionHash,
  );
}
