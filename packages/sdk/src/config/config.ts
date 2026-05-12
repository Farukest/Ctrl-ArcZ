import type { Address, Hash, Hex } from 'viem';
import { ctrlArcZAbi } from '../abi/ctrlArcZ.js';
import { CTRL_ARCZ_ADDRESS, USDC_DECIMALS } from '../chains/arcTestnet.js';
import type { ClientPair } from '../transfer/transfer.js';
import type { RiskLevel } from '../risk/types.js';

export type ClaimMode = 'CODE' | 'SIGNATURE' | 'REGISTERED';

const CLAIM_MODE_INDEX: Record<ClaimMode, number> = { CODE: 0, SIGNATURE: 1, REGISTERED: 2 };

export const MAX_RECALL_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const MAX_FEE_BPS = 100;

/**
 * How one integrator wants protected transfers to behave. The contract is shared;
 * this is what makes an exchange's withdrawal screen and a P2P wallet behave
 * differently on top of it.
 */
export interface IntegratorConfig {
  /** Seconds the recipient has to claim before the transfer becomes refundable. */
  recallWindow: number;
  claimMode: ClaimMode;
  /** Integrator fee on a successful claim, in basis points. 0–100 (max 1%). */
  feeBps: number;
  feeRecipient: Address;
  /**
   * Below this amount, protection costs more than it saves: `recommendTransferMode`
   * returns `plain`. Base units (6 decimals).
   */
  minProtectedAmount: bigint;
  /** What a `warning` verdict does: stop the send, or let the user decide. */
  onWarning: 'warn' | 'block';
}

export type DefineConfigInput = Partial<IntegratorConfig>;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Sensible P2P-wallet defaults: a one-hour window, no fee, protect above 10 USDC. */
export function defineConfig(input: DefineConfigInput = {}): IntegratorConfig {
  const config: IntegratorConfig = {
    recallWindow: input.recallWindow ?? 60 * 60,
    claimMode: input.claimMode ?? 'CODE',
    feeBps: input.feeBps ?? 0,
    feeRecipient: input.feeRecipient ?? ZERO_ADDRESS,
    minProtectedAmount: input.minProtectedAmount ?? 10n * 10n ** BigInt(USDC_DECIMALS),
    onWarning: input.onWarning ?? 'warn',
  };

  if (!Number.isInteger(config.recallWindow) || config.recallWindow < 0) {
    throw new Error('recallWindow must be a non-negative whole number of seconds');
  }
  if (config.recallWindow > MAX_RECALL_WINDOW_SECONDS) {
    throw new Error(`recallWindow exceeds the contract maximum of 7 days`);
  }
  if (config.feeBps < 0 || config.feeBps > MAX_FEE_BPS) {
    throw new Error(`feeBps must be between 0 and ${MAX_FEE_BPS} (1%)`);
  }
  if (config.feeBps > 0 && config.feeRecipient === ZERO_ADDRESS) {
    throw new Error('feeRecipient is required when feeBps > 0');
  }
  if (config.claimMode !== 'CODE') {
    throw new Error(`claimMode ${config.claimMode} is reserved; only CODE ships in v1`);
  }

  return config;
}

/**
 * Protection costs a second transaction. Under `minProtectedAmount` that is not
 * worth it, and pretending otherwise would just train users to click through the
 * flow — so the SDK says so out loud instead of quietly protecting dust.
 */
export function recommendTransferMode(
  config: IntegratorConfig,
  amount: bigint,
): 'protected' | 'plain' {
  return amount < config.minProtectedAmount ? 'plain' : 'protected';
}

/** Whether a risk verdict should stop this integrator's send. */
export function shouldBlockSend(config: IntegratorConfig, level: RiskLevel): boolean {
  if (level === 'block') return true;
  if (level === 'warning') return config.onWarning === 'block';
  return false;
}

export interface RegisterConfigResult {
  configId: Hex;
  txHash: Hash;
}

/**
 * Registers the behaviour on-chain and returns its `configId`.
 *
 * Idempotent by construction: the contract derives the id from the parameters and
 * the caller, so an app can call this on every boot and always get the same id
 * back without storing anything.
 */
export async function registerConfig(
  clients: ClientPair,
  config: IntegratorConfig,
): Promise<RegisterConfigResult> {
  // The full account object, not its address: see the note in transfer.ts.
  const account = clients.walletClient.account;
  if (!account) throw new Error('walletClient has no account');
  const address = clients.contractAddress ?? (CTRL_ARCZ_ADDRESS as Address);

  const args = [
    config.recallWindow,
    CLAIM_MODE_INDEX[config.claimMode],
    config.feeBps,
    config.feeRecipient,
  ] as const;

  const { result: configId } = await clients.publicClient.simulateContract({
    address,
    abi: ctrlArcZAbi,
    functionName: 'createConfig',
    args,
    account,
  });

  const txHash = await clients.walletClient.writeContract({
    address,
    abi: ctrlArcZAbi,
    functionName: 'createConfig',
    args,
    account,
    chain: clients.walletClient.chain ?? null,
  });

  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { configId, txHash };
}
