import 'dotenv/config';
import { isAddress, parseUnits, type Address, type Hex } from 'viem';

/**
 * Keeper configuration. Every value is read from the environment and validated
 * here, so a misconfigured keeper fails at startup rather than halfway through a
 * tick with money in flight. Nothing is defaulted that would be unsafe to guess:
 * the key and the box address have no defaults at all.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function privateKey(name: string): Hex {
  const v = required(name);
  const withPrefix = (v.startsWith('0x') ? v : `0x${v}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) throw new Error(`${name} is not a 32-byte hex key`);
  return withPrefix;
}

function address(name: string): Address {
  const v = required(name);
  if (!isAddress(v)) throw new Error(`${name} is not an address`);
  return v;
}

function optionalAddress(name: string): Address | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  if (!isAddress(v)) throw new Error(`${name} is not an address`);
  return v;
}

/** USDC amount from a human string ("0.05"), in base units. */
function usdc(name: string, fallback: string): bigint {
  const v = process.env[name] ?? fallback;
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`${name} must be a USDC amount like "0.05"`);
  return parseUnits(v, 6);
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const v = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(v) || v < min || v > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return v;
}

export const env = {
  /** The keeper's own key. Server-side only; it is never shipped to a client. */
  keeperPk: privateKey('KEEPER_PK'),

  /**
   * The keeper's salary box: a SpendPolicyAccount in PULL mode whose target is
   * the keeper and whose vault is the operator. Optional — without it the keeper
   * still works, it just cannot refill itself and stops when its balance runs
   * down to the reserve.
   */
  salaryBox: optionalAddress('KEEPER_SALARY_BOX'),
  /** Where the co-signer lives. Only consulted for the salary pull. */
  cosignUrl: process.env.KEEPER_COSIGN_URL || 'http://127.0.0.1:8787/api/cosign',

  /**
   * What one reclaim is assumed to cost. Also the floor for "worth the gas".
   * Measured at 0.001653 USDC on Arc Testnet; the default keeps ~3x headroom for a
   * busier chain without eliding transfers that are small but still worth saving.
   */
  gasPerAction: usdc('KEEPER_GAS_PER_ACTION', '0.005'),
  /** Never spend below this, so the keeper can always afford its next salary pull. */
  reserve: usdc('KEEPER_RESERVE', '0.20'),
  /** Refill when below this. */
  lowWater: usdc('KEEPER_LOW_WATER', '0.50'),
  /** Refill up to this. */
  targetBalance: usdc('KEEPER_TARGET_BALANCE', '1.00'),

  /** Upper bound on reclaims per tick. */
  maxActions: integer('KEEPER_MAX_ACTIONS', 5, 1, 50),
  /** Upper bound on chain state reads per tick, so a large backlog cannot stall a tick. */
  maxReads: integer('KEEPER_MAX_READS', 40, 1, 500),
  pollMs: integer('KEEPER_POLL_MS', 60_000, 5_000, 3_600_000),
  /** How far back the first scan looks for still-open transfers. */
  backfillBlocks: integer('KEEPER_BACKFILL_BLOCKS', 200_000, 1_000, 5_000_000),
  /** Blocks per incremental scan. Bounded so a failed tick cannot widen the next. */
  scanSpanBlocks: integer('KEEPER_SCAN_SPAN_BLOCKS', 2_000, 100, 9_000),

  /** Log the decisions without sending any transaction. */
  dryRun: process.env.KEEPER_DRY_RUN === '1',
};

export type KeeperEnv = typeof env;
export { address as requireAddressEnv };
