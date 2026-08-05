import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { fundEphemeral, MODE_PULL, type EphemeralPolicy } from '../src/shield/shield.js';
import { vaultHash } from '../src/shield/digest.js';

/**
 * Funding is the moment a spend box stops being a proposal and starts holding money,
 * and it is the last point at which anything can still be checked. These tests are
 * about the check, not the transfer: the transfer is one ERC-20 call and cannot
 * really fail in an interesting way, while a box whose deployed policy is not the one
 * the caller specified is exactly the thing worth refusing to pay into.
 */

const TOKEN = '0x3600000000000000000000000000000000000000' as Address;
const BOX = '0x00000000000000000000000000000000000000b0' as Address;
const OWNER = '0x00000000000000000000000000000000000000f0' as Address;
const COSIGNER = '0x00000000000000000000000000000000000000c5' as Address;
const TARGET = '0x00000000000000000000000000000000000000ee' as Address;
const VAULT = '0x00000000000000000000000000000000000000aa' as Address;

const policy: EphemeralPolicy = {
  token: TOKEN,
  owner: OWNER,
  cosigner: COSIGNER,
  vault: VAULT,
  target: TARGET,
  maxAmount: 100_000n,
  perPullMax: 20_000n,
  expiry: 2_000_000_000,
  interval: 60,
  mode: MODE_PULL,
};

/** What the chain claims the deployed box holds. Defaults to a faithful deployment. */
function chainState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    token: TOKEN,
    cosigner: COSIGNER,
    target: TARGET,
    vaultHash: vaultHash(VAULT),
    maxAmount: 100_000n,
    perPullMax: 20_000n,
    expiry: 2_000_000_000,
    interval: 60,
    mode: MODE_PULL,
    ...overrides,
  } as Record<string, unknown>;
}

function clients(state = chainState()) {
  const writeContract = vi.fn(async (_args: { address: Address; args: unknown[] }) => '0xfeed' as Hex);
  const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' }));
  return {
    clients: {
      publicClient: {
        readContract: vi.fn(async ({ functionName }: { functionName: string }) => state[functionName]),
        waitForTransactionReceipt,
      },
      walletClient: { account: { address: OWNER }, chain: null, writeContract },
    },
    writeContract,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (c: any, amount = 50_000n) => fundEphemeral(c, BOX, amount, policy);

describe('fundEphemeral — the deployed policy is checked before any money moves', () => {
  it('transfers the amount to the box when every field matches', async () => {
    const { clients: c, writeContract } = clients();
    await expect(call(c)).resolves.toBe('0xfeed');
    expect(writeContract).toHaveBeenCalledTimes(1);
    const arg = writeContract.mock.calls[0]![0];
    // Paid in the policy's own token, to the box, for the requested amount.
    expect(arg.address).toBe(TOKEN);
    expect(arg.args).toEqual([BOX, 50_000n]);
  });

  // Each of these is a box that would still accept the transfer perfectly well, and
  // would then behave in a way the caller never agreed to.
  const tampered: Array<[string, Record<string, unknown>]> = [
    ['a different payee', { target: '0x00000000000000000000000000000000000000bd' as Address }],
    ['a different co-signer', { cosigner: '0x00000000000000000000000000000000000000bc' as Address }],
    ['a vault that is not ours', { vaultHash: vaultHash('0x00000000000000000000000000000000000000bb' as Address) }],
    ['a larger total cap', { maxAmount: 1_000_000n }],
    ['a larger per-pull cap', { perPullMax: 100_000n }],
    ['a longer expiry', { expiry: 2_100_000_000 }],
    ['no rate limit', { interval: 0 }],
    ['the wrong spend mode', { mode: 0 }],
    ['a different token', { token: '0x0000000000000000000000000000000000000dead' as Address }],
  ];

  it.each(tampered)('refuses to fund a box with %s, and sends nothing', async (_label, override) => {
    const { clients: c, writeContract } = clients(chainState(override));
    await expect(call(c)).rejects.toThrow(/policy mismatch/i);
    // The point of the guard: the refusal happens before the transfer, not after.
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('refuses a non-positive amount without touching the chain', async () => {
    const { clients: c, writeContract } = clients();
    await expect(call(c, 0n)).rejects.toThrow(/positive/i);
    await expect(call(c, -1n)).rejects.toThrow(/positive/i);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('accepts perPullMax 0, which the contract normalises to the total cap', async () => {
    // The contract stores maxAmount when asked for "no tighter cap than the
    // cumulative one", so the deployed value differs from the requested 0 and a
    // naive equality check would reject a correctly deployed box.
    const { clients: c, writeContract } = clients(chainState({ perPullMax: 100_000n }));
    await expect(
      fundEphemeral(c as never, BOX, 50_000n, { ...policy, perPullMax: 0n }),
    ).resolves.toBe('0xfeed');
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});
