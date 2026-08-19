import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { readAccount } from '../src/index.js';

/**
 * The policy read, and specifically the token in it.
 *
 * A spend box is created holding one ERC-20 and every figure beside it -- balance,
 * cap, per-pull ceiling -- is denominated in that one. The token used to be supplied
 * by whoever was reading, from a constant, and the constant was Arc's USDC. That
 * address is not a contract on Base, Ethereum Sepolia, Arbitrum Sepolia or Fuji, so
 * the balance read did not return a wrong number there, it threw; the subscriptions
 * list caught it, dropped the row, and a funded box was simply missing from the
 * screen. Reading the token from the box is what makes that impossible to get wrong.
 */

const BOX = '0x1111111111111111111111111111111111111111' as Address;
const ARC_USDC = '0x3600000000000000000000000000000000000000' as Address;
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

/** A box answering its getters, with the token it was created holding. */
function boxOn(token: Address, overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    nonce: 3n,
    spent: 250_000n,
    remaining: 750_000n,
    target: '0x4444444444444444444444444444444444444444' as Address,
    perPullMax: 100_000n,
    interval: 86_400n,
    lastPull: 1_770_000_000n,
    expiry: 1_780_000_000n,
    mode: 1,
    token,
    ...overrides,
  };
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (!(functionName in answers)) throw new Error(`unexpected getter: ${functionName}`);
      return answers[functionName];
    },
  } as unknown as PublicClient;
}

describe('readAccount', () => {
  it('reports the token the box holds, not a chain-wide assumption', async () => {
    const state = await readAccount(boxOn(BASE_USDC), BOX);
    expect(state.token).toBe(BASE_USDC);
    // The point of the test: nothing about the read is pinned to Arc.
    expect(state.token).not.toBe(ARC_USDC);
  });

  it('reads Arc boxes the same way, with no special case', async () => {
    expect((await readAccount(boxOn(ARC_USDC), BOX)).token).toBe(ARC_USDC);
  });

  it('still returns the rest of the policy, with the counters narrowed to numbers', async () => {
    const state = await readAccount(boxOn(BASE_USDC), BOX);
    expect(state).toMatchObject({
      nonce: 3n,
      spent: 250_000n,
      remaining: 750_000n,
      perPullMax: 100_000n,
      mode: 1,
    });
    // Times and counts come off the chain as bigints and are used as numbers.
    expect(state.interval).toBe(86_400);
    expect(state.lastPull).toBe(1_770_000_000);
    expect(state.expiry).toBe(1_780_000_000);
  });

  it('fails rather than guessing when the box cannot say what it holds', async () => {
    // An address with no code answers nothing. A token defaulted here would be a
    // guess about where someone's money is, made at the one moment we know we
    // cannot read it.
    const dead = {
      readContract: async () => {
        throw new Error('returned no data ("0x")');
      },
    } as unknown as PublicClient;
    await expect(readAccount(dead, BOX)).rejects.toThrow(/no data/);
  });
});
