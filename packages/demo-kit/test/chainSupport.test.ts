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
      // Claiming judges nobody, so it needs the contract and nothing else.
      expect(supportsChain(chainId, 'receive'), `${d.chain} receive`).toBe(true);

      const routed = chainId === ARC_TESTNET_CHAIN_ID || d.privatePayRouter !== undefined;
      const judged = d.explorerApi !== undefined;
      expect(supportsChain(chainId, 'privatePay'), `${d.chain} privatePay`).toBe(routed && judged);
    }
  });

  /**
   * Everything that puts the co-signer's name on a payment needs a recipient
   * history to judge, and a chain without one fails closed on every attempt. The
   * screen has to say that before the form is filled in, not after.
   */
  it('gates the firewall-judged features on having a history source', () => {
    for (const chainId of deployedChainIds()) {
      const d = deploymentFor(chainId)!;
      const judged = d.explorerApi !== undefined;
      for (const feature of ['protectedSend', 'subscriptions'] as const) {
        expect(supportsChain(chainId, feature), `${d.chain} ${feature}`).toBe(judged);
      }
    }
    // Fuji is the chain that has the contracts and no Blockscout.
    const fuji = CCTP_CHAINS.Avalanche_Fuji.chainId;
    expect(deploymentFor(fuji)?.explorerApi).toBeUndefined();
    expect(supportsChain(fuji, 'receive')).toBe(true);
    expect(supportsChain(fuji, 'privatePay')).toBe(false);
    expect(supportsChain(fuji, 'subscriptions')).toBe(false);
    expect(supportsChain(fuji, 'protectedSend')).toBe(false);
  });

  /** Subscriptions need the relayer, and the relayer now runs on every deployed
   *  chain -- proved by deploying a real box and co-signing for it on each. */
  it('offers subscriptions wherever the relayer runs and a history can be read', () => {
    for (const chainId of deployedChainIds()) {
      const expected = deploymentFor(chainId)?.explorerApi !== undefined;
      expect(supportsChain(chainId, 'subscriptions'), String(chainId)).toBe(expected);
    }
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
