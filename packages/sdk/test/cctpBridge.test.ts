import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  bridgeFromWallet,
  quoteBridge,
  CCTP_CHAINS,
  CCTP_TOKEN_MESSENGER,
  FORWARDING_HOOK,
} from '../src/bridge/cctp.js';

/**
 * The property under test is not "does it bridge". It is that the money burned is
 * the sender's own, and that nothing is signed before the transfer is known to be
 * affordable. A bridge that funds itself from an operator's wallet works fine in a
 * demo and stops being a product the moment two people use it.
 */

const WALLET = '0x00000000000000000000000000000000000000f0' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;

const FEES = [
  { finalityThreshold: 2000, forwardFee: { med: '9999' }, minimumFee: 1 },
  { finalityThreshold: 1000, forwardFee: { med: '2000' }, minimumFee: 1 },
];

function fetchStub(overrides: { fees?: unknown; messages?: unknown } = {}) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/fees/')) {
      return { ok: true, json: async () => overrides.fees ?? FEES } as never;
    }
    return {
      ok: true,
      json: async () => overrides.messages ?? { messages: [{ forwardTxHash: '0xf0' }] },
    } as never;
  });
}

function clients(balance: bigint, allowance = 0n) {
  const writeContract = vi.fn(async (_a: { address: Address; args: unknown[] }) => '0xapprove' as Hex);
  const sendTransaction = vi.fn(async (_a: { to: Address; data: Hex }) => '0xburn' as Hex);
  return {
    writeContract,
    sendTransaction,
    clients: {
      publicClient: {
        readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
          functionName === 'balanceOf' ? balance : allowance,
        ),
        waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
      },
      walletClient: { account: { address: WALLET }, chain: null, writeContract, sendTransaction },
    },
  };
}

describe('quoteBridge prices the transfer before it is signed', () => {
  it('adds the forwarding fee and the protocol fee to the amount', async () => {
    const q = await quoteBridge({
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      fetchImpl: fetchStub() as never,
    });
    // forwardFee 2000 + protocol (1_000_000 * 100 / 1_000_000 = 100)
    expect(q.maxFee).toBe(2100n);
    expect(q.total).toBe(1_002_100n);
    expect(q.amount).toBe(1_000_000n);
  });

  it('refuses a route Circle will not forward quickly, rather than guessing a fee', async () => {
    // A fee too small for Circle to accept strands the transfer at the burn, which
    // is the one step that cannot be undone. Better to refuse before signing.
    const noFast = [{ finalityThreshold: 2000, forwardFee: { med: '1' }, minimumFee: 1 }];
    await expect(
      quoteBridge({
        from: 'Arc_Testnet',
        to: 'Base_Sepolia',
        amount: 1_000_000n,
        fetchImpl: fetchStub({ fees: noFast }) as never,
      }),
    ).rejects.toThrow(/not quoting/i);
  });
});

describe('bridgeFromWallet burns the sender own funds', () => {
  const run = (c: ReturnType<typeof clients>, extra = {}) =>
    bridgeFromWallet(c.clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      fetchImpl: fetchStub() as never,
      ...extra,
    });

  it('mints back to the sending wallet by default', async () => {
    const c = clients(10_000_000n);
    await run(c);
    const burn = c.sendTransaction.mock.calls[0]![0];
    expect(burn.to).toBe(CCTP_TOKEN_MESSENGER);
    // mintRecipient is the sender, left-padded to 32 bytes.
    expect(burn.data.toLowerCase()).toContain(WALLET.slice(2).toLowerCase());
    // and the forwarding hook is present, so Circle submits the destination mint
    expect(burn.data.toLowerCase()).toContain(FORWARDING_HOOK.slice(2).toLowerCase());
  });

  it('can pay someone else, but only when told to explicitly', async () => {
    const c = clients(10_000_000n);
    await run(c, { recipient: OTHER });
    const burn = c.sendTransaction.mock.calls[0]![0];
    expect(burn.data.toLowerCase()).toContain(OTHER.slice(2).toLowerCase());
  });

  it('refuses, without signing anything, when the wallet cannot cover it', async () => {
    // 1 USDC balance against a 1.0021 USDC total. The chain would refuse too, but
    // only after the user had approved a transaction.
    const c = clients(1_000_000n);
    await expect(run(c)).rejects.toThrow(/holds .* and the transfer needs/i);
    expect(c.writeContract).not.toHaveBeenCalled();
    expect(c.sendTransaction).not.toHaveBeenCalled();
  });

  it('approves exactly the total, never an unbounded allowance', async () => {
    const c = clients(10_000_000n);
    await run(c);
    const approve = c.writeContract.mock.calls[0]![0];
    expect(approve.args[0]).toBe(CCTP_TOKEN_MESSENGER);
    expect(approve.args[1]).toBe(1_002_100n);
  });

  it('skips the approval when the allowance already covers it', async () => {
    const c = clients(10_000_000n, 5_000_000n);
    await run(c);
    expect(c.writeContract).not.toHaveBeenCalled();
    expect(c.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns the burn hash even when Circle has not forwarded yet', async () => {
    // The burn is permanent and the attestation outlives any timeout, so a missing
    // forward means "not yet", never "lost". The hash is the receipt.
    const c = clients(10_000_000n);
    const res = await bridgeFromWallet(c.clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      fetchImpl: fetchStub({ messages: { messages: [] } }) as never,
      timeoutMs: 10,
    });
    expect(res.burnTxHash).toBe('0xburn');
    expect(res.forwardTxHash).toBeUndefined();
  });

  it('refuses a same-chain or non-positive transfer', async () => {
    const c = clients(10_000_000n);
    await expect(run(c, { to: 'Arc_Testnet' })).rejects.toThrow(/must differ/i);
    await expect(run(c, { amount: 0n })).rejects.toThrow(/positive/i);
    expect(c.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('chain data matches Circle documentation', () => {
  it('carries the CCTP domains as published', () => {
    expect(CCTP_CHAINS.Arc_Testnet.domain).toBe(26);
    expect(CCTP_CHAINS.Ethereum_Sepolia.domain).toBe(0);
    expect(CCTP_CHAINS.Base_Sepolia.domain).toBe(6);
  });

  it('uses the one TokenMessenger address Circle deploys to every testnet', () => {
    expect(CCTP_TOKEN_MESSENGER).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
  });
});
