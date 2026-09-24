import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The app runs on one network per build. These load the modules fresh under each
 * setting, because the network is read once, when the module is first imported.
 */
async function load(network: 'mainnet' | 'testnet') {
  vi.resetModules();
  vi.stubEnv('VITE_NETWORK', network);
  const net = await import('../src/network.js');
  const catalog = await import('../src/chainCatalog.js');
  const sdk = await import('@ctrl-arcz/sdk');
  return { net, catalog, sdk };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a mainnet build', () => {
  it('is mainnet when nothing says otherwise', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_NETWORK', '');
    const net = await import('../src/network.js');
    expect(net.APP_NETWORK).toBe('mainnet');
    expect(net.APP_ARC_CHAIN_ID).toBe(5042);
  });

  it('never offers a testnet chain in any bridge list', async () => {
    const { catalog, sdk } = await load('mainnet');
    for (const purpose of [
      'cctpSource',
      'cctpDestination',
      'gatewayDeposit',
      'gatewaySource',
    ] as const) {
      const names = catalog.chainsFor(purpose);
      expect(names.length, purpose).toBeGreaterThan(0);
      for (const n of names) expect(sdk.CCTP_CHAINS[n].testnet, `${purpose} ${n}`).toBe(false);
      // Arc leads, as it does on testnet.
      expect(names[0], purpose).toBe('Arc');
    }
  });

  it('offers none of our testnet deployments as a place to pay', async () => {
    const { catalog, sdk } = await load('mainnet');
    for (const n of catalog.chainsFor('protectedSend')) {
      expect(sdk.CCTP_CHAINS[n].testnet, n).toBe(false);
    }
  });
});

describe('a testnet build', () => {
  it('never offers a mainnet chain', async () => {
    const { net, catalog, sdk } = await load('testnet');
    expect(net.APP_ARC_CHAIN_ID).toBe(5042002);
    for (const n of catalog.chainsFor('cctpSource'))
      expect(sdk.CCTP_CHAINS[n].testnet, n).toBe(true);
  });
});
