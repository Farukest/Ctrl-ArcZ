import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import {
  bridgeFromWallet,
  findForwardedMint,
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
  const writeContract = vi.fn(
    async (_a: { address: Address; args: unknown[] }) => '0xapprove' as Hex,
  );
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
  /**
   * Transcribed from docs-arc, then each row read off its own chain: symbol, decimals,
   * chain id, and that the TokenMessenger has code there. These assertions are what
   * stops a later edit from reintroducing a wrong address by hand -- and a wrong USDC
   * address does not fail loudly, it burns real money into the wrong contract.
   */
  const VERIFIED: Array<[keyof typeof CCTP_CHAINS, number, number, string]> = [
    ['Ethereum_Sepolia', 0, 11155111, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'],
    ['Avalanche_Fuji', 1, 43113, '0x5425890298aed601595a70AB815c96711a31Bc65'],
    ['OP_Sepolia', 2, 11155420, '0x5fd84259d66Cd46123540766Be93DFE6D43130D7'],
    ['Arbitrum_Sepolia', 3, 421614, '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'],
    ['Base_Sepolia', 6, 84532, '0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
    ['Polygon_Amoy', 7, 80002, '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'],
    ['Unichain_Sepolia', 10, 1301, '0x31d0220469e10c4E71834a79b1f276d740d3768F'],
    ['Linea_Sepolia', 11, 59141, '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7'],
    ['Codex_Testnet', 12, 812242, '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f'],
    ['Sonic_Testnet', 13, 14601, '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51'],
    ['World_Chain_Sepolia', 14, 4801, '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88'],
    ['Monad_Testnet', 15, 10143, '0x534b2f3A21130d7a60830c2Df862319e593943A3'],
    ['Sei_Testnet', 16, 1328, '0x4fCF1784B31630811181f670Aea7A7bEF803eaED'],
    ['XDC_Apothem', 18, 51, '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4'],
    ['Ink_Testnet', 21, 763373, '0xFabab97dCE620294D2B0b0e46C68964e326300Ac'],
    ['Plume_Testnet', 22, 98867, '0xcB5f30e335672893c7eb944B374c196392C19D18'],
    ['Arc_Testnet', 26, 5042002, '0x3600000000000000000000000000000000000000'],
    ['Injective_Testnet', 29, 1439, '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d'],
    ['Morph_Hoodi', 30, 2910, '0x7433b41C6c5e1d58D4Da99483609520255ab661B'],
    ['Cronos_Testnet', 32, 338, '0xEb33dc5fac03833e132593659e1dE7256aB59794'],
  ];

  it.each(VERIFIED)(
    '%s carries the domain, chain id and USDC that were verified',
    (name, domain, chainId, usdc) => {
      expect(CCTP_CHAINS[name]).toEqual({ domain, chainId, usdc });
    },
  );

  it('ships every chain that was verified, and none that was not', () => {
    expect(Object.keys(CCTP_CHAINS).sort()).toEqual(VERIFIED.map(([n]) => n).sort());
  });

  it('renders every USDC address in EIP-55 checksum form', () => {
    // Arc's is all zeros below the prefix, so checksumming is a no-op there; every
    // other address must match what getAddress produces or a wallet may reject it.
    for (const [name, chain] of Object.entries(CCTP_CHAINS)) {
      expect(getAddress(chain.usdc), name).toBe(chain.usdc);
    }
  });

  it('keeps domains and chain ids unique, so no route can be ambiguous', () => {
    const chains = Object.values(CCTP_CHAINS);
    expect(new Set(chains.map((c) => c.domain)).size).toBe(chains.length);
    expect(new Set(chains.map((c) => c.chainId)).size).toBe(chains.length);
  });

  it('uses the one TokenMessenger address Circle deploys to every testnet', () => {
    expect(CCTP_TOKEN_MESSENGER).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
  });
});

describe('an interrupted transfer can be finished from its burn hash alone', () => {
  /**
   * This is the recovery path. A browser that reloaded, or a phone that was closed,
   * between the burn and the mint has nothing but the burn hash -- and that has to be
   * enough, because the money is already gone from the source chain.
   */
  it('reports the mint Circle submitted, with no signer and no wallet', async () => {
    const hash = await findForwardedMint({
      sourceDomain: 26,
      burnTxHash: '0xburn',
      fetchImpl: fetchStub() as never,
    });
    expect(hash).toBe('0xf0');
  });

  it('says "not yet" rather than throwing when Circle has not forwarded', async () => {
    const hash = await findForwardedMint({
      sourceDomain: 26,
      burnTxHash: '0xburn',
      fetchImpl: fetchStub({ messages: { messages: [] } }) as never,
    });
    expect(hash).toBeUndefined();
  });

  it('treats a network failure as "not yet", never as a lost transfer', async () => {
    // A caller that saw this throw would reasonably mark the transfer failed. The
    // burn is on chain and the attestation does not expire, so it is not.
    const dead = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      findForwardedMint({ sourceDomain: 26, burnTxHash: '0xburn', fetchImpl: dead as never }),
    ).resolves.toBeUndefined();
  });
});

describe('a wallet on the wrong network is stopped before it signs', () => {
  it('names the network to switch to, rather than failing at the burn', async () => {
    const c = clients(10_000_000n);
    // Connected to Base Sepolia while asked to bridge from Arc.
    c.clients.walletClient.chain = { id: 84532 } as never;
    await expect(
      bridgeFromWallet(c.clients as never, {
        from: 'Arc_Testnet',
        to: 'Base_Sepolia',
        amount: 1_000_000n,
        fetchImpl: fetchStub() as never,
      }),
    ).rejects.toThrow(/Switch it to Arc Testnet \(chain 5042002\)/);
    expect(c.sendTransaction).not.toHaveBeenCalled();
  });
});
