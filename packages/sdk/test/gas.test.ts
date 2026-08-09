import { describe, expect, it } from 'vitest';
import {
  gasReserve,
  readGasReserve,
  spendableAfterGas,
  MIN_GAS_RESERVE,
  PAY_GAS_LIMIT,
  SEND_GAS_LIMIT,
} from '../src/index.js';

/**
 * What a payment costs on top of itself, on a chain that charges gas in the money
 * being sent.
 *
 * The numbers are checked against the Android client rather than against
 * themselves: both apps quote the same user the cost of the same payment, and two
 * different answers is a bug neither codebase can see on its own.
 */

const GWEI = 1_000_000_000n;

describe('gasReserve', () => {
  it('scales an 18-decimal gas price down to a 6-decimal balance', () => {
    // 100 Gwei x 700,000 = 0.07 USDC. Without the scaling step this is 70 billion
    // USDC and every balance in the app becomes unspendable.
    expect(gasReserve(100n * GWEI, SEND_GAS_LIMIT)).toBe(70_000n);
  });

  it('holds the floor at Arc\'s minimum gas price', () => {
    // Arc's base fee bottoms out at 20 Gwei, where both limits come to well under
    // the floor: 0.014 USDC for a send and 0.018 for a private payment.
    expect(gasReserve(20n * GWEI, SEND_GAS_LIMIT)).toBe(MIN_GAS_RESERVE);
    expect(gasReserve(20n * GWEI, PAY_GAS_LIMIT)).toBe(MIN_GAS_RESERVE);
  });

  it('takes over from the floor once gas is high enough to matter', () => {
    // The floor is worth 71.4 Gwei at the send limit, so this is the first price
    // where the estimate is the larger of the two.
    expect(gasReserve(80n * GWEI, SEND_GAS_LIMIT)).toBe(56_000n);
  });

  it('never returns zero for a node that reports no gas price', () => {
    // A momentarily zero price would otherwise produce a Max of the whole balance,
    // which is the one amount guaranteed to produce a transaction that cannot be
    // mined.
    expect(gasReserve(0n, SEND_GAS_LIMIT)).toBe(MIN_GAS_RESERVE);
  });

  it('reserves more for a private payment than for a send', () => {
    // Three transactions rather than two, and the third one is the one that pays
    // the merchant: running out before it strands the money in an account that
    // already holds it.
    expect(PAY_GAS_LIMIT).toBeGreaterThan(SEND_GAS_LIMIT);
    expect(gasReserve(100n * GWEI, PAY_GAS_LIMIT)).toBeGreaterThan(
      gasReserve(100n * GWEI, SEND_GAS_LIMIT),
    );
  });

  it('defaults to the send limit', () => {
    expect(gasReserve(100n * GWEI)).toBe(gasReserve(100n * GWEI, SEND_GAS_LIMIT));
  });
});

describe('spendableAfterGas', () => {
  it('holds the reserve back', () => {
    expect(spendableAfterGas(1_000_000n, 50_000n)).toBe(950_000n);
  });

  it('is zero rather than negative when the reserve is the whole balance', () => {
    expect(spendableAfterGas(50_000n, 50_000n)).toBe(0n);
    expect(spendableAfterGas(10_000n, 50_000n)).toBe(0n);
  });

  it('leaves nothing behind that the reserve does not need', () => {
    // What it returns has to be sendable: spendable + reserve == balance exactly.
    expect(spendableAfterGas(3_342_506n, 55_447n) + 55_447n).toBe(3_342_506n);
  });
});

describe('readGasReserve', () => {
  it('asks the chain', async () => {
    const client = { getGasPrice: async () => 100n * GWEI };
    expect(await readGasReserve(client, SEND_GAS_LIMIT)).toBe(70_000n);
  });

  it('falls back to the floor when the node cannot be reached', async () => {
    // A screen that cannot read a gas price still has to offer a Max. Refusing to
    // show one stops a payment the wallet could well afford.
    const client = {
      getGasPrice: async () => {
        throw new Error('offline');
      },
    };
    expect(await readGasReserve(client)).toBe(MIN_GAS_RESERVE);
  });
});
