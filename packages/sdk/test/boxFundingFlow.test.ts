import { describe, expect, it, vi } from 'vitest';
import type { Address, WalletClient } from 'viem';
import { fundBoxFromGateway } from '../src/shield/boxFunding.js';

/**
 * What survives the funding being interrupted.
 *
 * The wallet route finished in one mined transaction, so there was nothing to
 * interrupt: either the transfer went or it did not. Circle's mint lands seconds to
 * minutes after the intent is accepted, and that gap is exactly where a tab gets
 * closed, a phone locks, or a network drops. What matters is that nothing in that
 * window can leave money somewhere nobody can find it.
 *
 * The spend is injected rather than mocked at the module, and a fresh one per test
 * rather than one reset between them: a shared mock carries its last implementation
 * into the next test whenever a reset is missed, and that failure looks like a bug
 * in the code under test.
 */

const BOX = '0x1111111111111111111111111111111111111111' as Address;
const clients = { walletClient: {} as WalletClient };

/** A stand-in for Circle that runs the script it is given. */
function fakeSpend(
  impl: (params: {
    from: string;
    to: string;
    amount: bigint;
    recipient?: Address;
    timeoutMs?: number;
    onTransferId?: (id: string) => void;
  }) => Promise<unknown> = async () => ({}),
) {
  const calls: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (_clients: unknown, params: Record<string, unknown>) => {
    calls.push(params);
    return impl(params as never);
  });
  return { fn: fn as never, calls };
}

describe('fundBoxFromGateway', () => {
  it('refuses an amount that is not money', async () => {
    // A zero intent is accepted by nothing and costs a signature to find out.
    const spend = fakeSpend();
    for (const amount of [0n, -1n]) {
      await expect(
        fundBoxFromGateway(clients, { account: BOX, amount, from: 'Arc_Testnet', spend: spend.fn }),
      ).rejects.toThrow(/positive/i);
    }
    expect(spend.calls).toHaveLength(0);
  });

  it('sends to Arc, to the box, from the chosen chain', async () => {
    const spend = fakeSpend();
    await fundBoxFromGateway(clients, {
      account: BOX,
      amount: 5n,
      from: 'Base_Sepolia',
      spend: spend.fn,
    });
    const p = spend.calls[0]!;
    expect(p.to).toBe('Arc_Testnet');
    expect(p.recipient).toBe(BOX);
    // The source chain is not "wherever the balance is": an intent carries one
    // source domain, and Circle refuses one aimed at a chain with nothing on it.
    expect(p.from).toBe('Base_Sepolia');
    expect(p.amount).toBe(5n);
  });

  it("hands back Circle's id the moment the intent is accepted, before the mint", async () => {
    // The window this closes: a tab shut during the wait leaves the id behind, so
    // the transfer can still be asked about. Reporting it only with the finished
    // result would leave an interrupted funding with nothing to look up.
    const seen: string[] = [];
    const spend = fakeSpend(async (p) => {
      p.onTransferId?.('circle-123');
      seen.push('id reported');
      // The mint takes its time; the caller must already have the id by now.
      await new Promise((r) => setTimeout(r, 5));
      seen.push('mint finished');
      return {};
    });
    const out = await fundBoxFromGateway(clients, {
      account: BOX,
      amount: 5n,
      from: 'Arc_Testnet',
      spend: spend.fn,
      onTransferId: (id) => seen.push(`caller got ${id}`),
    });
    // What matters is the ordering against the mint, not the exact interleaving:
    // the caller has the id in hand while Circle is still working, which is what
    // makes an interrupted wait recoverable.
    expect(seen).toContain('caller got circle-123');
    expect(seen.indexOf('caller got circle-123')).toBeLessThan(seen.indexOf('mint finished'));
    expect(out.transferId).toBe('circle-123');
  });

  it('still returns the id when the mint never lands', async () => {
    // A spend that gives up waiting is "not yet", and the id is the whole receipt.
    const spend = fakeSpend(async (p) => {
      p.onTransferId?.('circle-late');
      return {};
    });
    const out = await fundBoxFromGateway(clients, {
      account: BOX,
      amount: 5n,
      from: 'Arc_Testnet',
      spend: spend.fn,
    });
    expect(out.transferId).toBe('circle-late');
  });

  it('reports no id when Circle never accepted the intent', async () => {
    // Nothing was accepted, so there is nothing to follow, and claiming otherwise
    // would put a row in the history for a transfer that does not exist.
    const spend = fakeSpend();
    const out = await fundBoxFromGateway(clients, {
      account: BOX,
      amount: 5n,
      from: 'Arc_Testnet',
      spend: spend.fn,
    });
    expect(out.transferId).toBeUndefined();
  });

  it('lets a refusal through instead of swallowing it', async () => {
    // A refused intent must reach the screen. Returning quietly would leave the
    // form claiming a subscription over a box that was never paid for.
    const spend = fakeSpend(async () => {
      throw new Error('insufficient Gateway balance');
    });
    await expect(
      fundBoxFromGateway(clients, {
        account: BOX,
        amount: 5n,
        from: 'Arc_Testnet',
        spend: spend.fn,
      }),
    ).rejects.toThrow(/insufficient/i);
  });

  it('passes a timeout through only when one was given', async () => {
    // `exactOptionalPropertyTypes`: an explicit undefined is not the same as absent,
    // and the spend has a default of its own that is worth keeping.
    const bare = fakeSpend();
    await fundBoxFromGateway(clients, {
      account: BOX,
      amount: 5n,
      from: 'Arc_Testnet',
      spend: bare.fn,
    });
    expect('timeoutMs' in bare.calls[0]!).toBe(false);

    const withTimeout = fakeSpend();
    await fundBoxFromGateway(clients, {
      account: BOX,
      amount: 5n,
      from: 'Arc_Testnet',
      spend: withTimeout.fn,
      timeoutMs: 42,
    });
    expect(withTimeout.calls[0]!.timeoutMs).toBe(42);
  });
});
