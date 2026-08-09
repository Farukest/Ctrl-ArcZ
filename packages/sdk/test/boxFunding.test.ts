import { describe, expect, it, vi } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { assertBoxFundable, awaitBoxFunded, isBoxFunding } from '../src/index.js';

/**
 * Paying a policy box out of the Gateway balance.
 *
 * Every case here ends, when it goes wrong, with money nobody can move: a mint to an
 * address the factory never brought to life, a mint into somebody else's box, or a
 * screen reporting a working subscription over an empty one. There is no recall on a
 * Gateway intent, so the checks either happen before the signature or they are
 * decoration.
 */

const BOX = '0x1111111111111111111111111111111111111111' as Address;
const USDC = '0x3600000000000000000000000000000000000000' as Address;

const policy = {
  token: USDC,
  owner: '0x2222222222222222222222222222222222222222' as Address,
  cosigner: '0x3333333333333333333333333333333333333333' as Address,
  vault: '0x2222222222222222222222222222222222222222' as Address,
  target: '0x4444444444444444444444444444444444444444' as Address,
  maxAmount: 10n,
  perPullMax: 2n,
  expiry: 999n,
  interval: 60n,
  mode: 1,
} as const;

describe('assertBoxFundable', () => {
  it('refuses an address with no code', async () => {
    // A mint to a counterfactual address succeeds and the tokens are then movable
    // only by whoever deploys that exact salt, which may be nobody, ever.
    const client = { getCode: async () => '0x' } as unknown as PublicClient;
    await expect(assertBoxFundable(client, BOX, policy)).rejects.toThrow(/not deployed/i);
  });

  it('refuses an undefined code answer the same way', async () => {
    const client = { getCode: async () => undefined } as unknown as PublicClient;
    await expect(assertBoxFundable(client, BOX, policy)).rejects.toThrow(/not deployed/i);
  });

  it('goes on to check the policy once the code is there', async () => {
    // Deployed is not enough: the same address with a different cap or expiry is a
    // box the payer never agreed to.
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'token': return USDC;
        case 'cosigner': return policy.cosigner;
        case 'target': return policy.target;
        case 'vaultHash': return `0x${'0'.repeat(64)}`;
        case 'maxAmount': return policy.maxAmount;
        case 'perPullMax': return policy.perPullMax;
        case 'expiry': return policy.expiry;
        case 'interval': return policy.interval;
        case 'mode': return policy.mode;
        default: return 0n;
      }
    });
    const client = { getCode: async () => '0x60806040', readContract } as unknown as PublicClient;
    // The vault hash is deliberately wrong, so this must throw rather than pass.
    await expect(assertBoxFundable(client, BOX, policy)).rejects.toThrow();
    expect(readContract).toHaveBeenCalled();
  });
});

describe('awaitBoxFunded', () => {
  /** A chain whose balance follows a script, one entry per read. */
  function client(balances: bigint[]) {
    let i = 0;
    return {
      readContract: async () => balances[Math.min(i++, balances.length - 1)],
    } as unknown as PublicClient;
  }

  it('is true as soon as the balance covers the amount', async () => {
    const funded = await awaitBoxFunded(client([5n]), BOX, 5n, USDC, { pollMs: 1 });
    expect(funded).toBe(true);
  });

  it('waits through an empty box and returns true when the mint lands', async () => {
    const funded = await awaitBoxFunded(client([0n, 0n, 5n]), BOX, 5n, USDC, {
      pollMs: 1,
      timeoutMs: 1_000,
    });
    expect(funded).toBe(true);
  });

  it('is false, not an error, when the wait runs out', async () => {
    // "Not yet" and "failed" lead to different screens. Circle's transfer id is
    // already persisted, so a timeout leaves something that can still be asked about.
    const funded = await awaitBoxFunded(client([0n]), BOX, 5n, USDC, { pollMs: 1, timeoutMs: 5 });
    expect(funded).toBe(false);
  });

  it('looks once more after the deadline, so a late mint is not called a timeout', async () => {
    // The balance is empty on the only read taken before the deadline and full on
    // the one after it. Without the final look this reports failure over a funded box.
    let reads = 0;
    const c = { readContract: async () => (++reads <= 1 ? 0n : 5n) } as unknown as PublicClient;
    expect(await awaitBoxFunded(c, BOX, 5n, USDC, { pollMs: 1, timeoutMs: 0 })).toBe(true);
  });

  it('treats a dropped read as unknown rather than as an empty box', async () => {
    let reads = 0;
    const c = {
      readContract: async () => {
        if (++reads === 1) throw new Error('rpc down');
        return 5n;
      },
    } as unknown as PublicClient;
    expect(await awaitBoxFunded(c, BOX, 5n, USDC, { pollMs: 1, timeoutMs: 1_000 })).toBe(true);
  });

  it('accepts more than was asked for', async () => {
    // Two funding attempts, or a rounding difference, must not read as unfunded.
    expect(await awaitBoxFunded(client([9n]), BOX, 5n, USDC, { pollMs: 1 })).toBe(true);
  });
});

describe('isBoxFunding', () => {
  const boxes = new Set(['0xaaa1', '0xbbb2']);

  it('recognises a transfer into a known box', () => {
    expect(isBoxFunding('0xaaa1', boxes)).toBe(true);
  });

  it('ignores case and surrounding space', () => {
    // Records come from storage and from the chain, and only one of those lowercases.
    expect(isBoxFunding('0xAAA1', boxes)).toBe(true);
    expect(isBoxFunding('  0xAaA1  ', boxes)).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isBoxFunding('0xdead', boxes)).toBe(false);
    expect(isBoxFunding(undefined, boxes)).toBe(false);
    expect(isBoxFunding('', boxes)).toBe(false);
  });

  it('is false when no boxes are known yet', () => {
    // Discovery has not run. Claiming every transfer is box funding would empty the
    // bridge list and fill the other one with transfers that are not.
    expect(isBoxFunding('0xaaa1', new Set())).toBe(false);
  });

  it('splits a list into two halves that are complementary', () => {
    // The two lists are one list filtered twice. A record must land in exactly one:
    // in both it is shown twice, in neither it is lost.
    const records = ['0xaaa1', '0xdead', '0xBBB2', undefined, '  0xaaa1 '];
    const funding = records.filter((r) => isBoxFunding(r, boxes));
    const rest = records.filter((r) => !isBoxFunding(r, boxes));
    expect(funding).toHaveLength(3);
    expect(rest).toHaveLength(2);
    expect(funding.length + rest.length).toBe(records.length);
  });
});
