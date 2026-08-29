import { describe, expect, it } from 'vitest';
import {
  CCTP_CHAINS,
  GATEWAY_CHAIN_NAMES,
  deploymentFor,
  readRpcUrls,
} from '../src/index.js';

/**
 * Which chains this app can read on its own.
 *
 * The distinction these tests exist to hold: "we deployed contracts here" and
 * "this chain has endpoints we can dial" are different facts, and for a while the
 * second was answered with the first. `rpcUrls` lived only inside `DEPLOYMENTS`,
 * so the five chains carrying our contracts could be read from anywhere and the
 * other six could only be read while the wallet happened to be standing on them.
 *
 * Gateway serves every one of them and a spend can draw on every one, so six
 * reported their balance as unreadable -- on chains whose endpoints answer
 * perfectly well, holding real money. Probed 2026-08-27: 0.2 USDC sitting on both
 * OP Sepolia and Unichain Sepolia, shown as a blank.
 *
 * The count is deliberately not written down any more. It was eleven, Circle made
 * it twelve, and a test that says "all eleven" fails for the wrong reason.
 *
 * These are offline assertions about the table. Whether an endpoint is still
 * answering is a question for the network, not for `pnpm test`.
 */

describe('every Gateway chain can be read without moving the wallet', () => {
  it('has at least one read endpoint for every one of them', () => {
    // The property that matters, stated once. A chain the allocator may draw on
    // is a chain whose balance has to be knowable, or the split is decided on a
    // figure the screen could not show.
    for (const chain of GATEWAY_CHAIN_NAMES) {
      const urls = readRpcUrls(CCTP_CHAINS[chain].chainId);
      expect(urls.length, `${chain} has no read endpoint`).toBeGreaterThan(0);
    }
  });

  it('prefers a deployment’s own endpoints where there are any', () => {
    // Those were verified when the contracts went up and are the ones the event
    // readers already lean on, so they win rather than sitting beside a second list.
    for (const chain of GATEWAY_CHAIN_NAMES) {
      const id = CCTP_CHAINS[chain].chainId;
      const deployed = deploymentFor(id)?.rpcUrls;
      if (deployed?.length) expect(readRpcUrls(id)).toEqual(deployed);
    }
  });

  it('answers nothing for a chain it has never heard of', () => {
    // An empty list is a real answer that callers turn into "cannot be read".
    // Inventing an endpoint would be worse than admitting the gap.
    expect(readRpcUrls(999_999_999)).toEqual([]);
    expect(readRpcUrls(undefined)).toEqual([]);
  });

  it('publishes only https endpoints, and no duplicates', () => {
    for (const chain of GATEWAY_CHAIN_NAMES) {
      const urls = readRpcUrls(CCTP_CHAINS[chain].chainId);
      for (const u of urls) expect(u, `${chain}: ${u}`).toMatch(/^https:\/\//);
      expect(new Set(urls).size, `${chain} lists an endpoint twice`).toBe(urls.length);
    }
  });
});
