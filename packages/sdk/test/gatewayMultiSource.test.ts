import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  gatewayBalance,
  spendFromGateway,
  GATEWAY_CHAIN_NAMES,
} from '../src/bridge/gateway.js';
import { allocate } from '../src/bridge/allocate.js';

/**
 * Drawing on several chains at once.
 *
 * A Gateway balance reads as one figure and spends per chain, so paying more
 * than any single chain holds takes one burn intent per chain. What makes that
 * bearable is that the intents are signed together as a `BurnIntentSet`: one
 * wallet prompt for four chains. These tests hold the parts a person cannot see
 * and would otherwise find out about only after signing -- the shape Circle
 * accepts, one signature, a distinct salt per intent, a per-leg balance check,
 * and the ceiling on what a refusal can talk the app into signing.
 */

const WALLET = '0x00000000000000000000000000000000000000f0' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;

function wallet() {
  const signTypedData = vi.fn(async (_a: unknown) => '0xsig' as Hex);
  return {
    signTypedData,
    clients: { walletClient: { account: { address: WALLET }, chain: null, signTypedData } },
  };
}

interface LegQuote {
  baseFee: string;
  maxFee: string;
  height: string;
}

/** Circle's estimate for an n-leg request: one entry per leg, one forwarding fee. */
function multiApi(
  legs: LegQuote[],
  over: { balances?: { domain: number; balance: string }[]; shortBy?: string } = {},
) {
  const bodies: { url: string; body: unknown }[] = [];
  let transferPosts = 0;
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.body) bodies.push({ url: u, body: JSON.parse(String(init.body)) });
    if (u.includes('/v1/estimate')) {
      return {
        ok: true,
        json: async () => ({
          body: legs.map((l) => ({ burnIntent: { maxFee: l.maxFee, maxBlockHeight: l.height } })),
          fees: {
            perIntent: legs.map((l) => ({ baseFee: l.baseFee })),
            forwardingFee: '0.016000',
          },
        }),
      } as never;
    }
    if (u.includes('/v1/balances')) {
      return {
        ok: true,
        json: async () => ({
          balances: over.balances ?? [
            { domain: 26, balance: '17.079313' },
            { domain: 6, balance: '12.890000' },
          ],
        }),
      } as never;
    }
    if (u.includes('/v1/transfer/')) {
      return {
        ok: true,
        json: async () => ({ status: 'finalized', transactionHash: '0xmint' }),
      } as never;
    }
    transferPosts += 1;
    if (over.shortBy && transferPosts === 1) {
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            message: `Insufficient total maxFee across intents to cover forwarding fee. Required additional: ${over.shortBy}`,
          }),
      } as never;
    }
    return {
      ok: true,
      status: 400,
      text: async () => 'refused',
      json: async () => ({ transferId: 'tr_set' }),
    } as never;
  });
  return { impl, bodies };
}

/**
 * Arc first (roomiest, so it absorbs the forwarding fee), then Base.
 *
 * The quoted figures are the shape Circle really returns, measured over one, two
 * and four legs: the first leg is quoted its base fee plus the whole forwarding
 * fee, and every leg after it is quoted its own base fee plus a tenth.
 */
const TWO: LegQuote[] = [
  { baseFee: '0.003500', maxFee: '19500', height: '60375344' }, // 3500 + 16000
  { baseFee: '0.010000', maxFee: '11000', height: '31000000' }, // 10000 * 1.1
];

const SOURCES = [
  { chain: 'Arc_Testnet' as const, value: 5_000_000n },
  { chain: 'Base_Sepolia' as const, value: 3_000_000n },
];

const transferPost = (a: ReturnType<typeof multiApi>) =>
  a.bodies.filter((b) => b.url.includes('/v1/transfer?'));

const setIntents = (body: unknown) =>
  (body as { burnIntentSet: { intents: Record<string, never>[] } }[])[0]?.burnIntentSet.intents ??
  [];

describe('a spend can draw on several chains under one signature', () => {
  const run = (a: ReturnType<typeof multiApi>, w: ReturnType<typeof wallet>, extra = {}) =>
    spendFromGateway(w.clients as never, {
      sources: SOURCES,
      to: 'Arc_Testnet',
      fetchImpl: a.impl as never,
      ...extra,
    });

  it('signs the set once, not once per chain', async () => {
    // The whole reason multi-source is usable. Two prompts for one payment is a
    // payment people abandon halfway, with one chain's money already committed.
    const a = multiApi(TWO);
    const w = wallet();
    await run(a, w);
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
    expect(w.signTypedData.mock.calls[0]?.[0]).toMatchObject({ primaryType: 'BurnIntentSet' });
  });

  it('sends the shape Circle accepts: an array, with the set inside it', async () => {
    // A top-level object is refused outright with "Expected array, received
    // object", and the element key differs between one intent and several.
    const a = multiApi(TWO);
    await run(a, wallet());
    const body = transferPost(a)[0]?.body;
    expect(Array.isArray(body)).toBe(true);
    expect(setIntents(body)).toHaveLength(2);
    expect((body as { signature: string }[])[0]?.signature).toBe('0xsig');
  });

  it('keeps the single-chain shape for a single chain', async () => {
    // One leg is not a one-element set. Circle reads `burnIntent`, and turning
    // every existing spend into a set would be a change nobody asked for.
    const a = multiApi([TWO[0]!]);
    const w = wallet();
    await spendFromGateway(w.clients as never, {
      from: 'Arc_Testnet',
      to: 'Arc_Testnet',
      amount: 1_000_000n,
      fetchImpl: a.impl as never,
    });
    expect(w.signTypedData.mock.calls[0]?.[0]).toMatchObject({ primaryType: 'BurnIntent' });
    expect((transferPost(a)[0]?.body as Record<string, unknown>[])[0]).toHaveProperty('burnIntent');
  });

  it('gives every intent its own salt', async () => {
    // One salt across the specs would hand Circle several intents that differ
    // only by source chain, which is the shape of a duplicate rather than of two
    // legs of one payment.
    const a = multiApi(TWO);
    await run(a, wallet());
    const intents = setIntents(transferPost(a)[0]?.body) as unknown as {
      spec: { salt: string };
    }[];
    expect(intents[0]?.spec.salt).not.toBe(intents[1]?.spec.salt);
    expect(intents[0]?.spec.salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('pays one recipient however many legs there are', async () => {
    /*
     * Measured against Circle: it ACCEPTS a set whose legs name different
     * recipients. One signature settled a transfer that paid two addresses
     * (transferId 22a4a205-a142-485a-b788-be67349ee649). That makes "who gets the
     * money" a per-leg field under a single approval, which is not something a
     * person can audit in a wallet prompt. So there is no parameter that can vary
     * it, and this is the test that keeps it that way.
     */
    const a = multiApi(TWO);
    await run(a, wallet(), { recipient: OTHER });
    const intents = setIntents(transferPost(a)[0]?.body) as unknown as {
      spec: { destinationRecipient: string; destinationDomain: number };
    }[];
    expect(intents[0]?.spec.destinationRecipient).toBe(intents[1]?.spec.destinationRecipient);
    // Circle enforces this one itself ("All burn intents in a request must have
    // the same destination domain"), which is exactly why it must never be the
    // first place we find out.
    expect(intents[0]?.spec.destinationDomain).toBe(intents[1]?.spec.destinationDomain);
  });

  it('checks each leg against its own chain, not against the total', async () => {
    // The failure this exists to prevent: 30 in total, 12.89 on Base, and a leg
    // asking Base for 15. Against the total it passes, the user signs, and Circle
    // refuses afterwards. Circle's estimate is no help: asked to price 1000 out of
    // a chain holding 17.2 it returned an ordinary quote.
    const a = multiApi(TWO);
    await expect(
      spendFromGateway(wallet().clients as never, {
        sources: [
          { chain: 'Arc_Testnet', value: 1_000_000n },
          { chain: 'Base_Sepolia', value: 15_000_000n },
        ],
        to: 'Arc_Testnet',
        fetchImpl: a.impl as never,
      }),
    ).rejects.toThrow(/Base Sepolia/);
  });

  it('puts the forwarding headroom on the first leg only', async () => {
    // Forwarding is charged once and lands on the leg passed first. A margin
    // spread evenly pads the small legs for nothing and leaves the first short.
    const a = multiApi(TWO);
    await run(a, wallet());
    const intents = setIntents(transferPost(a)[0]?.body) as unknown as { maxFee: string }[];
    // 19500 + (3500 + 16000) on the first leg; 11000 + 10000 on the second.
    expect(intents[0]?.maxFee).toBe('39000');
    expect(intents[1]?.maxFee).toBe('21000');
  });

  it('never signs more than the allocator reserved', async () => {
    /*
     * The invariant that makes a Max button safe. `allocate` decides whether a
     * split is possible by holding back a ceiling per leg; `spendFromGateway`
     * then signs one. If the signed ceiling were the larger of the two, every
     * amount the allocator called workable would be refused by the check
     * immediately after it -- the app disagreeing with itself, over money.
     *
     * They are computed in different modules from different inputs, one from a
     * measured table and one from Circle's live answer, so nothing but a test
     * keeps them in the right order. Not equal: the reserve is deliberately the
     * more generous of the two, so the fee has room to move between the quote
     * the allocator saw and the quote that is signed.
     */
    const a = multiApi(TWO);
    await run(a, wallet());
    const signed = (setIntents(transferPost(a)[0]?.body) as unknown as { maxFee: string }[]).reduce(
      (sum, i) => sum + BigInt(i.maxFee),
      0n,
    );
    // Balances chosen so the allocator genuinely needs both chains, and lands on
    // Arc first and Base second -- the same two legs the spend above signed.
    const reserved = allocate({
      amount: 8_000_000n,
      balances: [
        { chain: 'Arc_Testnet', balance: 5_000_000n },
        { chain: 'Base_Sepolia', balance: 5_000_000n },
      ],
      forwarding: 16_000n,
    });
    expect(reserved.legs.map((l) => l.chain)).toEqual(['Arc_Testnet', 'Base_Sepolia']);
    expect(reserved.ceiling).toBeGreaterThanOrEqual(signed);
  });

  it('expires each intent against its own source chain', async () => {
    // Chains run at different speeds, so one block height for all of them is the
    // wrong height for all but one.
    const a = multiApi(TWO);
    await run(a, wallet());
    const intents = setIntents(transferPost(a)[0]?.body) as unknown as {
      maxBlockHeight: string;
    }[];
    expect(intents[0]?.maxBlockHeight).toBe('60375344');
    expect(intents[1]?.maxBlockHeight).toBe('31000000');
  });

  it('re-signs once with the figure Circle names when the fee drifts', async () => {
    const a = multiApi(TWO, { shortBy: '0.000034' });
    const w = wallet();
    await run(a, w);
    expect(w.signTypedData).toHaveBeenCalledTimes(2);
    const second = setIntents(transferPost(a)[1]?.body) as unknown as { maxFee: string }[];
    // The top-up goes on the first leg; Circle checks the total across intents,
    // so slack anywhere in the set counts toward it.
    expect(second[0]?.maxFee).toBe('39034');
    expect(second[1]?.maxFee).toBe('21000');
  });

  it('will not be talked into signing an absurd fee', async () => {
    /*
     * `maxFee` is a ceiling, so whatever a refusal asks for is what could be
     * taken. A drift is cents; a demand for more than the whole quoted ceiling is
     * not a drift, and re-signing it would authorise it. The property that matters
     * is that the second signature never happens.
     */
    const a = multiApi(TWO, { shortBy: '500.0' });
    const w = wallet();
    await expect(run(a, w)).rejects.toThrow(/not a fee that drifted/);
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('refuses a leg that moves nothing', async () => {
    // A zero-value intent pays a base fee to deliver nothing.
    const a = multiApi(TWO);
    await expect(
      spendFromGateway(wallet().clients as never, {
        sources: [
          { chain: 'Arc_Testnet', value: 1_000_000n },
          { chain: 'Base_Sepolia', value: 0n },
        ],
        to: 'Arc_Testnet',
        fetchImpl: a.impl as never,
      }),
    ).rejects.toThrow(/moves nothing/);
  });

  it('refuses the same chain twice', async () => {
    const a = multiApi(TWO);
    await expect(
      spendFromGateway(wallet().clients as never, {
        sources: [
          { chain: 'Arc_Testnet', value: 1_000_000n },
          { chain: 'Arc_Testnet', value: 1_000_000n },
        ],
        to: 'Arc_Testnet',
        fetchImpl: a.impl as never,
      }),
    ).rejects.toThrow(/appears twice/);
  });

  it('refuses more legs than Circle will take', async () => {
    // Circle answers "Total number of burn intents (17) exceeds maximum allowed
    // (16)", and after the wallet has opened is the worst place to learn it.
    const a = multiApi(TWO);
    const many = GATEWAY_CHAIN_NAMES.map((chain) => ({ chain, value: 1_000_000n }));
    await expect(
      spendFromGateway(wallet().clients as never, {
        sources: [...many, ...many],
        to: 'Arc_Testnet',
        fetchImpl: a.impl as never,
      }),
    ).rejects.toThrow(/at most 16 chains/);
  });
});

describe('a balance is read exactly, not through a float', () => {
  it('keeps a subunit that Math.round would move', async () => {
    // `Math.round(Number(x) * 1e6)` can round a balance UP, and one subunit that
    // is not there is an intent Circle refuses after the signature. Past 2^53 it
    // simply loses digits.
    const impl = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/balances')) {
        return {
          ok: true,
          json: async () => ({ balances: [{ domain: 26, balance: '9007199254.740993' }] }),
        } as never;
      }
      throw new Error('unexpected call');
    });
    const b = await gatewayBalance({ depositor: WALLET, fetchImpl: impl as never });
    expect(b.byChain.Arc_Testnet).toBe(9_007_199_254_740_993n);
    expect(b.total).toBe(9_007_199_254_740_993n);
  });

  it('reports a balance it cannot read as zero rather than as something', async () => {
    // Under-reporting is the safe direction: it refuses a transfer that might have
    // worked, where over-reporting signs one that cannot.
    const impl = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/balances')) {
        return {
          ok: true,
          json: async () => ({ balances: [{ domain: 26, balance: 'not a number' }] }),
        } as never;
      }
      throw new Error('unexpected call');
    });
    const b = await gatewayBalance({ depositor: WALLET, fetchImpl: impl as never });
    expect(b.total).toBe(0n);
  });
});
