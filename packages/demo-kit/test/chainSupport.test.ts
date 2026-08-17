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
   * One-transaction Private Pay funds the box inside the call that creates and pays
   * from it, which needs a way to move the payer's tokens from inside a batch. Arc
   * has its `CallFrom` precompile; everywhere else that is the `PrivatePayRouter`,
   * pulling through Permit2. So the question this asks is not "is this Arc" but
   * "does this chain have a route", and a chain deployed without a router has to
   * answer no.
   *
   * The other three features need only the contracts.
   */
  it('gates Private Pay on a funding route, not on a deployment', () => {
    for (const chainId of deployedChainIds()) {
      const d = deploymentFor(chainId)!;
      expect(supportsChain(chainId, 'protectedSend')).toBe(true);
      expect(supportsChain(chainId, 'receive')).toBe(true);

      const routed = chainId === ARC_TESTNET_CHAIN_ID || d.privatePayRouter !== undefined;
      expect(supportsChain(chainId, 'privatePay'), `${d.chain} privatePay`).toBe(routed);
    }
  });

  /**
   * Subscriptions need the relayer, and the relayer is only offered where it has
   * been run. Two of the four new chains refuse a relayed deploy for reasons that
   * are recorded and not yet understood, so the screen does not offer the feature
   * there. This test exists so that widening the list is a deliberate act with a
   * passing live run behind it.
   */
  it('offers subscriptions only where the relayer has been proven', () => {
    expect(supportsChain(ARC_TESTNET_CHAIN_ID, 'subscriptions')).toBe(true);
    expect(supportsChain(CCTP_CHAINS.Ethereum_Sepolia.chainId, 'subscriptions')).toBe(true);
    expect(supportsChain(CCTP_CHAINS.Arbitrum_Sepolia.chainId, 'subscriptions')).toBe(true);
    expect(supportsChain(CCTP_CHAINS.Base_Sepolia.chainId, 'subscriptions')).toBe(false);
    expect(supportsChain(CCTP_CHAINS.Avalanche_Fuji.chainId, 'subscriptions')).toBe(false);
  });

  /** Arc is the one chain that does this without a contract of ours in the middle. */
  it('needs no router on Arc, and one everywhere else', () => {
    expect(deploymentFor(ARC_TESTNET_CHAIN_ID)?.privatePayRouter).toBeUndefined();
    expect(supportsChain(ARC_TESTNET_CHAIN_ID, 'privatePay')).toBe(true);

    const base = CCTP_CHAINS.Base_Sepolia.chainId;
    expect(deploymentFor(base)?.privatePayRouter).toBeDefined();
    expect(supportsChain(base, 'privatePay')).toBe(true);
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
