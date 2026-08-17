import { describe, it, expect } from 'vitest';
import {
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS,
  deployedChainIds,
  deploymentFor,
} from '@ctrl-arcz/sdk';
import { preferredChainFor, supportsChain, type ChainFeature } from '../src/chainSupport.js';

const FEATURES: ChainFeature[] = ['protectedSend', 'receive', 'privatePay', 'subscriptions'];

describe('supportsChain', () => {
  it('allows every feature on Arc, where everything is deployed', () => {
    for (const f of FEATURES) expect(supportsChain(ARC_TESTNET_CHAIN_ID, f)).toBe(true);
  });

  /**
   * A deployment is necessary and it is not always sufficient.
   *
   * Base Sepolia has the contracts, so protected send, receive and subscriptions
   * work there. One-transaction Private Pay does not, and the reason is not a
   * missing address: it funds the box inside the same call that creates and pays
   * from it, which needs either Arc's native-is-USDC behaviour or its `CallFrom`
   * precompile. Standard Multicall3 does not preserve `msg.sender`, so batching a
   * `transfer` through it would move Multicall3's tokens rather than the payer's.
   *
   * This test is here so that turning that on becomes a deliberate change with a
   * funding route behind it, rather than something a new registry entry does by
   * accident.
   */
  it('separates "deployed here" from "works here"', () => {
    const base = CCTP_CHAINS.Base_Sepolia.chainId;
    expect(deploymentFor(base)).toBeDefined();
    expect(supportsChain(base, 'protectedSend')).toBe(true);
    expect(supportsChain(base, 'receive')).toBe(true);
    expect(supportsChain(base, 'subscriptions')).toBe(true);
    expect(supportsChain(base, 'privatePay')).toBe(false);
  });

  it('refuses every chain with no deployment', () => {
    const undeployed = Object.values(CCTP_CHAINS)
      .map((c) => c.chainId)
      .filter((id) => !deployedChainIds().includes(id));
    expect(undeployed.length).toBeGreaterThan(5);
    for (const id of undeployed) {
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

  it('offers Arc as the fix for every feature, since Arc can do all of them', () => {
    for (const f of FEATURES) expect(preferredChainFor(f)).toBe(ARC_TESTNET_CHAIN_ID);
  });

  /** Whatever it offers has to actually work there; a switch to a chain that would
   *  refuse the same operation is a fix button that fixes nothing. */
  it('only ever offers a chain the feature works on', () => {
    for (const f of FEATURES) expect(supportsChain(preferredChainFor(f), f)).toBe(true);
  });

  /**
   * Adding a chain is an entry in the deployment registry and nothing else. If this
   * ever needs a component edit, the seam has been lost.
   */
  it('answers from the registry, so a new chain is a data change', () => {
    for (const id of deployedChainIds()) {
      expect(deploymentFor(id)).toBeDefined();
      expect(supportsChain(id, 'receive')).toBe(true);
    }
  });
});
