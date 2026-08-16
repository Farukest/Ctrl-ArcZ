import { describe, it, expect } from 'vitest';
import { ARC_TESTNET_CHAIN_ID, CCTP_CHAINS } from '@ctrl-arcz/sdk';
import { preferredChainFor, supportsChain, type ChainFeature } from '../src/chainSupport.js';

const FEATURES: ChainFeature[] = ['protectedSend', 'receive', 'privatePay', 'subscriptions'];

describe('supportsChain', () => {
  it('allows every feature on Arc, where the contracts are', () => {
    for (const f of FEATURES) expect(supportsChain(ARC_TESTNET_CHAIN_ID, f)).toBe(true);
  });

  it('refuses every other chain we bridge to, none of which has a deployment', () => {
    const others = Object.values(CCTP_CHAINS)
      .map((c) => c.chainId)
      .filter((id) => id !== ARC_TESTNET_CHAIN_ID);
    expect(others.length).toBeGreaterThan(5);
    for (const id of others) {
      for (const f of FEATURES) expect(supportsChain(id, f)).toBe(false);
    }
  });

  /**
   * The wallet can be on anything, including a chain this app has never heard of.
   * "I do not know this network" has to answer no, not undefined: the caller uses
   * the answer to decide whether to show a form that submits a transaction.
   */
  it('treats an unknown chain, and no chain at all, as unsupported', () => {
    for (const f of FEATURES) {
      expect(supportsChain(5170642, f)).toBe(false);
      expect(supportsChain(undefined, f)).toBe(false);
      expect(supportsChain(0, f)).toBe(false);
    }
  });

  it('offers Arc as the fix for every feature', () => {
    for (const f of FEATURES) expect(preferredChainFor(f)).toBe(ARC_TESTNET_CHAIN_ID);
  });

  /**
   * Pinned deliberately. Subscriptions look like the exception, because their
   * budget is funded out of the Gateway balance on any chain, and creating one
   * sends no transaction from the wallet at all. What this flag guards is the
   * other half: pulling and cancelling go through the session's Arc-pinned
   * clients. If a deployment ever lands elsewhere, this is the line to change.
   */
  it('is a per-feature list, so a second deployment is a data change here', () => {
    expect(supportsChain(CCTP_CHAINS.Base_Sepolia.chainId, 'subscriptions')).toBe(false);
    expect(supportsChain(CCTP_CHAINS.Base_Sepolia.chainId, 'protectedSend')).toBe(false);
  });
});
