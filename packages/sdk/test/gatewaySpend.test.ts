import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  depositToGateway,
  findGatewayMint,
  gatewayBalance,
  quoteGatewaySpend,
  spendFromGateway,
  waitForGatewayMint,
  isGatewayWithdrawal,
  GATEWAY_WALLET,
  GATEWAY_MINTER,
  GATEWAY_CHAIN_NAMES,
  DEPOSIT_CONFIRMATION_SECONDS,
} from '../src/bridge/gateway.js';
import { CCTP_CHAINS } from '../src/bridge/cctp.js';

/**
 * Gateway's whole proposition is that the money waiting in the contract is the
 * sender's own and that spending it needs nothing but their signature. These tests
 * hold that line: no operator balance, no API key, and no state where a caller is
 * left polling for a transfer that has already definitively failed.
 */

const WALLET = '0x00000000000000000000000000000000000000f0' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;
const SALT = `0x${'11'.repeat(32)}` as Hex;

/** Circle quotes a flat fee; measured identical for 1, 5 and 200 USDC. */
const FEE = '55457';
/**
 * The same figure, split the way Circle's estimate actually returns it: the
 * source chain's gas, the forwarding fee that carries the destination's, and
 * whatever is left as the transfer fee. Only the first two can drift, which is
 * what the headroom is sized against.
 */
const GAS_PART = 45_457n; // 0.01 baseFee + 0.035457 forwardingFee

function api(
  over: {
    balances?: { domain: number; balance: string }[];
    status?: Record<string, unknown>;
    transferId?: string | null;
    transferOk?: boolean;
    estimateOk?: boolean;
    /** Refuse the first submit with Circle's own shortfall sentence. */
    shortBy?: string;
  } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let transferPosts = 0;
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    const u = String(url);
    if (u.includes('/v1/estimate')) {
      return {
        ok: over.estimateOk ?? true,
        status: 500,
        text: async () => 'nope',
        json: async () => ({
          body: [{ burnIntent: { maxFee: FEE, maxBlockHeight: '99' } }],
          fees: { perIntent: [{ baseFee: '0.01' }], forwardingFee: '0.035457' },
        }),
      } as never;
    }
    if (u.includes('/v1/balances')) {
      return {
        ok: true,
        json: async () => ({
          balances: over.balances ?? [{ domain: 26, balance: '10.000000' }],
        }),
      } as never;
    }
    if (u.includes('/v1/transfer/')) {
      return {
        ok: true,
        json: async () => over.status ?? { status: 'finalized', transactionHash: '0xmint' },
      } as never;
    }
    // POST /v1/transfer
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
      ok: over.transferOk ?? true,
      status: 400,
      text: async () => 'refused',
      json: async () => ({
        transferId: over.transferId === null ? undefined : (over.transferId ?? 'tr_1'),
      }),
    } as never;
  });
  return { impl, calls };
}

function wallet() {
  const signTypedData = vi.fn(async (_a: unknown) => '0xsig' as Hex);
  return {
    signTypedData,
    clients: { walletClient: { account: { address: WALLET }, chain: null, signTypedData } },
  };
}

describe('the spend is authorised by the sender signature, not by a server', () => {
  const run = (a: ReturnType<typeof api>, w: ReturnType<typeof wallet>, extra = {}) =>
    spendFromGateway(w.clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      salt: SALT,
      fetchImpl: a.impl as never,
      ...extra,
    });

  it('sends no API key or authorization header anywhere', async () => {
    // The signature over the intent is the authority. A key here would mean the
    // operator was vouching for the transfer, which is the thing being removed.
    const a = api();
    const w = wallet();
    await run(a, w);
    expect(a.calls.length).toBeGreaterThan(2);
    for (const { url, init } of a.calls) {
      const names = Object.keys((init?.headers ?? {}) as Record<string, string>).map((k) =>
        k.toLowerCase(),
      );
      expect(
        names.filter((n) => n !== 'content-type'),
        url,
      ).toEqual([]);
      // and nothing smuggled into the query string either
      expect(url).not.toMatch(/api[-_]?key|token=|secret/i);
    }
  });

  it('signs an intent naming the sender as depositor and signer', async () => {
    const a = api();
    const w = wallet();
    await run(a, w);
    const signed = w.signTypedData.mock.calls[0]![0] as {
      primaryType: string;
      message: { spec: Record<string, string> };
    };
    expect(signed.primaryType).toBe('BurnIntent');
    expect(String(signed.message.spec.sourceDepositor).toLowerCase()).toContain(
      WALLET.slice(2).toLowerCase(),
    );
    expect(String(signed.message.spec.sourceSigner).toLowerCase()).toContain(
      WALLET.slice(2).toLowerCase(),
    );
  });

  it('mints back to the sender by default, and elsewhere only when told', async () => {
    const a = api();
    const w = wallet();
    await run(a, w);
    let spec = (w.signTypedData.mock.calls[0]![0] as { message: { spec: Record<string, string> } })
      .message.spec;
    expect(String(spec.destinationRecipient).toLowerCase()).toContain(
      WALLET.slice(2).toLowerCase(),
    );

    const w2 = wallet();
    await run(api(), w2, { recipient: OTHER });
    spec = (w2.signTypedData.mock.calls[0]![0] as { message: { spec: Record<string, string> } })
      .message.spec;
    expect(String(spec.destinationRecipient).toLowerCase()).toContain(OTHER.slice(2).toLowerCase());
  });

  it('leaves the destination caller open, so no single address gates the mint', async () => {
    const a = api();
    const w = wallet();
    await run(a, w);
    const spec = (
      w.signTypedData.mock.calls[0]![0] as { message: { spec: Record<string, string> } }
    ).message.spec;
    expect(BigInt(String(spec.destinationCaller))).toBe(0n);
  });

  it('gives every intent a fresh salt, so two identical transfers stay distinct', async () => {
    const w1 = wallet();
    const w2 = wallet();
    await spendFromGateway(w1.clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      fetchImpl: api().impl as never,
    });
    await spendFromGateway(w2.clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      fetchImpl: api().impl as never,
    });
    const salt = (c: ReturnType<typeof wallet>) =>
      (c.signTypedData.mock.calls[0]![0] as { message: { spec: { salt: string } } }).message.spec
        .salt;
    expect(salt(w1)).not.toBe(salt(w2));
    expect(salt(w1)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('refuses without signing when the Gateway balance cannot cover it', async () => {
    // 1 USDC of balance against 1.055457 needed. Nothing should be signed, and the
    // message has to name the deposit that would fix it.
    const a = api({ balances: [{ domain: 26, balance: '1.000000' }] });
    const w = wallet();
    await expect(run(a, w)).rejects.toThrow(/Deposit on Arc Testnet first/i);
    expect(w.signTypedData).not.toHaveBeenCalled();
  });

  it('checks the source chain balance, not the total across chains', async () => {
    // Measured against Circle: an intent sourced where the depositor holds nothing
    // comes back "available 0", however much they hold elsewhere. Comparing against
    // the total passes the check and is then rejected after the user has signed.
    const a = api({
      balances: [
        { domain: 26, balance: '50.000000' }, // plenty on Arc
        { domain: 6, balance: '0' }, // nothing on Base, which is the source here
      ],
    });
    const w = wallet();
    await expect(run(a, w, { from: 'Base_Sepolia', to: 'Arc_Testnet' })).rejects.toThrow(
      /balance on Base Sepolia is 0/i,
    );
    expect(w.signTypedData).not.toHaveBeenCalled();
  });

  it('says where the rest of the money is, so the refusal is actionable', async () => {
    const a = api({
      balances: [
        { domain: 26, balance: '50.000000' },
        { domain: 6, balance: '0' },
      ],
    });
    // Named as a fact rather than as an instruction. A spend can draw on several
    // chains at once now, so "go and stand on Arc" is no longer the advice; what
    // the reader needs to know is that each leg spends only its own chain's
    // deposit, which is why 50 elsewhere did not save this one.
    await expect(run(a, wallet(), { from: 'Base_Sepolia', to: 'Arc_Testnet' })).rejects.toThrow(
      /You hold 50 on other chains; a transfer can draw on several of them at once/i,
    );
  });

  it('refuses a non-positive spend', async () => {
    const w = wallet();
    await expect(run(api(), w, { amount: 0n })).rejects.toThrow(/moves nothing/i);
    expect(w.signTypedData).not.toHaveBeenCalled();
  });

  it('allows a same-chain transfer, because that is how money comes back out', async () => {
    // This was refused, which left a door money could go in but not out of: the
    // only way back to the chain you started on was to bridge away and bridge home.
    const a = api();
    const w = wallet();
    await run(a, w, { to: 'Arc_Testnet' });
    const spec = (
      w.signTypedData.mock.calls[0]![0] as { message: { spec: Record<string, number> } }
    ).message.spec;
    expect(spec.sourceDomain).toBe(26);
    expect(spec.destinationDomain).toBe(26);
    expect(w.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('names a same-chain move as a withdrawal', () => {
    expect(isGatewayWithdrawal({ from: 'Arc_Testnet', to: 'Arc_Testnet' })).toBe(true);
    expect(isGatewayWithdrawal({ from: 'Arc_Testnet', to: 'Base_Sepolia' })).toBe(false);
  });

  it('surfaces a refusal from Circle rather than inventing a transfer', async () => {
    const a = api({ transferOk: false });
    // Circle's sentence, not the JSON envelope it arrives in.
    await expect(run(a, wallet())).rejects.toThrow(/Gateway refused the transfer: refused/);
  });

  it('does not pretend to have a transfer when the API returns no id', async () => {
    const a = api({ transferId: null });
    await expect(run(a, wallet())).rejects.toThrow(/returned no id/i);
  });
});

describe('the quote is flat, and it is asked for every time', () => {
  it('adds the fee to the amount to get what the balance must hold', async () => {
    const q = await quoteGatewaySpend({
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 200_000_000n,
      depositor: WALLET,
      fetchImpl: api().impl as never,
    });
    // Measured against Circle: the same fee for 1, 5 and 200 USDC.
    expect(q.quotedFee).toBe(55_457n);
    // The headroom is the gas-bearing part again, which is what Circle's fee page
    // says can move ("add a buffer to account for gas fee fluctuations"). Not a
    // percentage of the total: the transfer fee is a fixed fraction of the amount
    // and cannot drift, so padding it buys nothing.
    expect(q.maxFee).toBe(55_457n + GAS_PART);
    expect(q.total).toBe(200_000_000n + 55_457n + GAS_PART);
  });

  it('signs a ceiling above the quote, since Circle charges the real fee anyway', async () => {
    // Measured: signing 0.065625 against a 0.055625 quote had 0.055 deducted, not
    // the ceiling. Headroom is free, and without it a two minute wallet prompt
    // ends in "Insufficient total maxFee across intents".
    const w = wallet();
    await spendFromGateway(w.clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      fetchImpl: api().impl as never,
    });
    const signed = w.signTypedData.mock.calls[0]![0] as { message: { maxFee: bigint } };
    expect(signed.message.maxFee).toBeGreaterThan(55_457n);
  });

  it('falls back to a floor when Circle sends no fee breakdown', async () => {
    // Without the split there is nothing to size the buffer against, and a fee
    // that arrives as one number is the case where guessing small has already
    // cost a funded subscription. The floor is deliberately far above the old
    // 0.0005, which a 0.000565 shortfall walked straight through.
    const bare = api();
    bare.impl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/v1/estimate')) {
        return {
          ok: true,
          json: async () => ({ body: [{ burnIntent: { maxFee: '100', maxBlockHeight: '99' } }] }),
        } as never;
      }
      return api().impl(url, init);
    }) as never;
    const q = await quoteGatewaySpend({
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      depositor: WALLET,
      fetchImpl: bare.impl as never,
    });
    expect(q.maxFee).toBe(5_100n); // 100 + the 0.005 floor
  });

  it('takes Circle at its word when it refuses and names the shortfall', async () => {
    /**
     * The fee moved past the ceiling between quoting and signing, which with a
     * wallet is however long the user takes to approve. Circle refuses and says
     * by exactly how much, and that figure beats any buffer: it is the answer
     * rather than an estimate of it. The intent is re-signed because `maxFee` is
     * inside the signed struct.
     */
    const a = api({ shortBy: '0.000565' });
    const w = wallet();
    const out = await spendFromGateway(w.clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      fetchImpl: a.impl as never,
    });
    expect(out.transferId).toBe('tr_1');

    const signed = w.signTypedData.mock.calls.map(
      (c) => (c[0] as { message: { maxFee: bigint } }).message.maxFee,
    );
    expect(signed).toHaveLength(2);
    expect(signed[1]).toBe(signed[0]! + 565n);
  });

  it('does not retry a refusal that is not about the fee', async () => {
    // A shortfall it was told the size of is one thing; anything else is a real
    // refusal, and retrying it blind would just sign twice for the same answer.
    const a = api({ transferOk: false });
    const w = wallet();
    await expect(
      spendFromGateway(w.clients as never, {
        from: 'Arc_Testnet',
        to: 'Base_Sepolia',
        amount: 1_000_000n,
        fetchImpl: a.impl as never,
      }),
    ).rejects.toThrow(/refused/);
    expect(w.signTypedData.mock.calls).toHaveLength(1);
  });

  it('refuses a route Circle will not price, rather than guessing', async () => {
    await expect(
      quoteGatewaySpend({
        from: 'Arc_Testnet',
        to: 'Base_Sepolia',
        amount: 1_000_000n,
        depositor: WALLET,
        fetchImpl: api({ estimateOk: false }).impl as never,
      }),
    ).rejects.toThrow(/Could not price/i);
  });

  /**
   * Measured in a real browser: an extension defining `BigInt.prototype.toJSON`
   * sent `"value":"1000000n"`, Circle answered "Must be a valid positive integer
   * string", and the subscription page could neither price nor create anything.
   *
   * `JSON.stringify` runs `toJSON` before the replacer, so a replacer that tests
   * `typeof v === 'bigint'` is handed a string and passes it through untouched.
   * The page cannot choose what else runs on it, so the amounts are converted
   * before `JSON.stringify` is given anything to convert.
   */
  it('sends decimal amounts even where BigInt serialisation has been redefined', async () => {
    const proto = BigInt.prototype as unknown as { toJSON?: () => string };
    proto.toJSON = function toJSON(this: bigint) {
      return `${this}n`;
    };
    try {
      const a = api();
      await quoteGatewaySpend({
        from: 'Arc_Testnet',
        to: 'Base_Sepolia',
        amount: 1_000_000n,
        depositor: WALLET,
        fetchImpl: a.impl as never,
      });
      const sent = a.calls.find((c) => c.url.includes('/v1/estimate'))!;
      const body = JSON.parse(String(sent.init!.body)) as [{ spec: { value: string } }];
      expect(body[0]!.spec.value).toBe('1000000');
    } finally {
      delete proto.toJSON;
    }
  });

  /** The same hazard on `toString`, which a template literal does not consult. */
  it('sends decimal amounts even where BigInt.toString has been redefined', async () => {
    const proto = BigInt.prototype as unknown as { toString: () => string };
    const real = proto.toString;
    proto.toString = function toString(this: bigint) {
      return `${real.call(this)}n`;
    };
    try {
      const a = api();
      await quoteGatewaySpend({
        from: 'Arc_Testnet',
        to: 'Base_Sepolia',
        amount: 1_000_000n,
        depositor: WALLET,
        fetchImpl: a.impl as never,
      });
      const sent = a.calls.find((c) => c.url.includes('/v1/estimate'))!;
      const body = JSON.parse(String(sent.init!.body)) as [{ spec: { value: string } }];
      expect(body[0]!.spec.value).toBe('1000000');
    } finally {
      proto.toString = real;
    }
  });
});

describe('an interrupted spend is finished from its transferId alone', () => {
  it('reports the mint once Circle has forwarded it', async () => {
    const s = await findGatewayMint({ transferId: 'tr_1', fetchImpl: api().impl as never });
    expect(s).toEqual({ state: 'done', mintTxHash: '0xmint' });
  });

  it('says pending, not failed, while the transfer is still working', async () => {
    const a = api({ status: { status: 'pending' } });
    expect(await findGatewayMint({ transferId: 'tr_1', fetchImpl: a.impl as never })).toEqual({
      state: 'pending',
    });
  });

  it('treats a network failure as pending, never as a lost transfer', async () => {
    const dead = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await findGatewayMint({ transferId: 'tr_1', fetchImpl: dead as never })).toEqual({
      state: 'pending',
    });
  });

  it('reports a definite failure as failed, with the reason Circle gave', async () => {
    // The opposite mistake to calling a slow transfer failed: polling forever for
    // one that will never arrive. Gateway does say so, so this has to read it.
    const a = api({
      status: { status: 'failed', forwardingDetails: { failureReason: 'insufficient balance' } },
    });
    expect(await findGatewayMint({ transferId: 'tr_1', fetchImpl: a.impl as never })).toEqual({
      state: 'failed',
      reason: 'insufficient balance',
    });
  });

  it('treats an expired attestation as failed too', async () => {
    const a = api({ status: { status: 'expired' } });
    const s = await findGatewayMint({ transferId: 'tr_1', fetchImpl: a.impl as never });
    expect(s.state).toBe('failed');
  });

  it('stops waiting and throws when the transfer has definitively failed', async () => {
    const a = api({ status: { status: 'failed', forwardingDetails: { failureReason: 'nope' } } });
    await expect(
      waitForGatewayMint({ transferId: 'tr_1', fetchImpl: a.impl as never, timeoutMs: 5000 }),
    ).rejects.toThrow(/could not complete transfer tr_1: nope/i);
  });

  it('returns undefined on timeout, because not yet is not lost', async () => {
    const a = api({ status: { status: 'pending' } });
    const hash = await waitForGatewayMint({
      transferId: 'tr_1',
      fetchImpl: a.impl as never,
      timeoutMs: 10,
    });
    expect(hash).toBeUndefined();
  });

  it('hands back the transferId before the wait, not after it', async () => {
    // The wait is where a tab gets closed. A caller told only at the end would have
    // nothing to ask about, which is the same hole that had to be closed for CCTP.
    const seen: string[] = [];
    const a = api({ status: { status: 'pending' } });
    await spendFromGateway(wallet().clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      timeoutMs: 10,
      fetchImpl: a.impl as never,
      onTransferId: (id) => seen.push(id),
    });
    expect(seen).toEqual(['tr_1']);
  });

  it('still returns the transferId when the mint has not landed yet', async () => {
    const a = api({ status: { status: 'pending' } });
    const res = await spendFromGateway(wallet().clients as never, {
      from: 'Arc_Testnet',
      to: 'Base_Sepolia',
      amount: 1_000_000n,
      timeoutMs: 10,
      fetchImpl: a.impl as never,
    });
    expect(res.transferId).toBe('tr_1');
    expect(res.mintTxHash).toBeUndefined();
  });
});

describe('the balance is read per chain, and only what is confirmed', () => {
  it('sums the chains and keeps the breakdown', async () => {
    const a = api({
      balances: [
        { domain: 26, balance: '2.500000' },
        { domain: 6, balance: '1.250000' },
      ],
    });
    const b = await gatewayBalance({ depositor: WALLET, fetchImpl: a.impl as never });
    expect(b.total).toBe(3_750_000n);
    expect(b.byChain.Arc_Testnet).toBe(2_500_000n);
    expect(b.byChain.Base_Sepolia).toBe(1_250_000n);
  });

  it('ignores a domain outside the supported set instead of miscounting it', async () => {
    const a = api({ balances: [{ domain: 999, balance: '5.000000' }] });
    const b = await gatewayBalance({ depositor: WALLET, fetchImpl: a.impl as never });
    expect(b.total).toBe(0n);
  });
});

describe('deposit moves the sender own USDC, through the method that credits it', () => {
  function depositClients(balance: bigint, allowance = 0n) {
    const writeContract = vi.fn(async (_a: { address: Address }) => '0xdep' as Hex);
    return {
      writeContract,
      clients: {
        publicClient: {
          readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
            functionName === 'balanceOf' ? balance : allowance,
          ),
          waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
        },
        walletClient: { account: { address: WALLET }, chain: null, writeContract },
      },
    };
  }

  it('calls deposit on the Gateway wallet, not a plain transfer to it', async () => {
    // A transfer to the contract does not credit the balance and does not fail
    // loudly either; the USDC just sits at an address that will not count it.
    const c = depositClients(10_000_000n);
    await depositToGateway(c.clients as never, { chain: 'Arc_Testnet', amount: 1_000_000n });
    const deposit = c.writeContract.mock.calls.at(-1)![0] as unknown as {
      address: Address;
      functionName: string;
      args: unknown[];
    };
    expect(deposit.address).toBe(GATEWAY_WALLET);
    expect(deposit.functionName).toBe('deposit');
    expect(deposit.args).toEqual([CCTP_CHAINS.Arc_Testnet.usdc, 1_000_000n]);
  });

  it('approves exactly the deposit, never an unbounded allowance', async () => {
    const c = depositClients(10_000_000n);
    await depositToGateway(c.clients as never, { chain: 'Arc_Testnet', amount: 1_000_000n });
    const approve = c.writeContract.mock.calls[0]![0] as unknown as { args: unknown[] };
    expect(approve.args).toEqual([GATEWAY_WALLET, 1_000_000n]);
  });

  it('refuses before signing when the wallet does not hold the USDC', async () => {
    const c = depositClients(500_000n);
    await expect(
      depositToGateway(c.clients as never, { chain: 'Arc_Testnet', amount: 1_000_000n }),
    ).rejects.toThrow(/holds 0\.5 USDC on Arc Testnet/);
    expect(c.writeContract).not.toHaveBeenCalled();
  });

  it('stops a wallet that is on the wrong network, and names the right one', async () => {
    const c = depositClients(10_000_000n);
    c.clients.walletClient.chain = { id: 84532 } as never;
    await expect(
      depositToGateway(c.clients as never, { chain: 'Arc_Testnet', amount: 1_000_000n }),
    ).rejects.toThrow(/Switch it to Arc Testnet \(chain 5042002\)/);
    expect(c.writeContract).not.toHaveBeenCalled();
  });
});

describe('chain data is not restated, and the wait is not averaged away', () => {
  it('takes every chain from the table that was verified on chain', () => {
    for (const name of GATEWAY_CHAIN_NAMES) {
      expect(CCTP_CHAINS[name]).toBeDefined();
    }
  });

  it('uses the one GatewayWallet and GatewayMinter Circle deploys everywhere', () => {
    expect(GATEWAY_WALLET).toBe('0x0077777d7EBA4688BDeF3E311b846F25870A19B9');
    expect(GATEWAY_MINTER).toBe('0x0022222ABE238Cc2C7Bb1f21003F0a260052475B');
  });

  it('carries a confirmation time for every chain, and they genuinely differ', () => {
    // Arc is half a second and Base is up to nineteen minutes. One number for both
    // would misdescribe whichever chain the user actually picked.
    for (const name of GATEWAY_CHAIN_NAMES) {
      expect(DEPOSIT_CONFIRMATION_SECONDS[name]).toBeGreaterThan(0);
    }
    expect(DEPOSIT_CONFIRMATION_SECONDS.Arc_Testnet).toBeLessThan(5);
    expect(DEPOSIT_CONFIRMATION_SECONDS.Base_Sepolia).toBeGreaterThan(600);
  });
});
