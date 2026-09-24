import { describe, expect, it, vi } from 'vitest';
import {
  CCTP_CHAINS,
  assertSameNetwork,
  gatewayApiFor,
  gatewayBalance,
  gatewayContracts,
  historySourceFor,
  irisApiFor,
  isTestnetChain,
  quoteBridge,
} from '../src/index.js';

/**
 * The mainnet half of the chain table, and the mistakes it produced on the way in.
 * Each case here was a real failure on Arc mainnet on 2026-09-24.
 */
describe('two networks in one table', () => {
  it('knows which network every chain is on', () => {
    expect(isTestnetChain(5042)).toBe(false);
    expect(isTestnetChain(5042002)).toBe(true);
    expect(isTestnetChain(999_999_999)).toBeUndefined();
  });

  it('refuses a route from one network to the other before quoting it', async () => {
    const fetchImpl = vi.fn();
    expect(() => assertSameNetwork('Arc', 'Base_Sepolia')).toThrow(/different networks/);
    await expect(
      quoteBridge({ from: 'Arc_Testnet', to: 'Base', amount: 1n, fetchImpl }),
    ).rejects.toThrow(/different networks/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks each network its own Circle services', () => {
    expect(irisApiFor(false)).toBe('https://iris-api.circle.com');
    expect(irisApiFor(true)).toBe('https://iris-api-sandbox.circle.com');
    expect(gatewayApiFor(false)).toBe('https://gateway-api.circle.com');
    expect(gatewayApiFor(true)).toBe('https://gateway-api-testnet.circle.com');
  });

  it('carries mainnet Gateway contracts, which are not testnet’s', () => {
    expect(gatewayContracts('Arc').wallet).toBe('0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE');
    expect(gatewayContracts('Arc_Testnet').wallet).toBe(
      '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    );
    expect(CCTP_CHAINS.Arc.tokenMessenger).not.toBe(CCTP_CHAINS.Arc_Testnet.tokenMessenger);
  });

  it('files a mainnet Gateway balance under the mainnet name', async () => {
    // Domain 26 is Arc on both networks. Read without the network, the mainnet
    // balance was filed under Arc_Testnet and a funded spend was refused.
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('gateway-api.circle.com');
      return new Response(JSON.stringify({ balances: [{ domain: 26, balance: '0.080000' }] }));
    }) as unknown as typeof fetch;
    const b = await gatewayBalance({ depositor: `0x${'1'.repeat(40)}`, testnet: false, fetchImpl });
    expect(b.byChain.Arc).toBe(80_000n);
    expect(b.byChain).not.toHaveProperty('Arc_Testnet');
  });

  it('reads Arc mainnet history from Alchemy, since its explorer API is closed', () => {
    expect(historySourceFor(5042)).toEqual({ kind: 'alchemy', network: 'arc-mainnet' });
    expect(historySourceFor(5042002)?.kind).toBe('blockscout');
  });
});
