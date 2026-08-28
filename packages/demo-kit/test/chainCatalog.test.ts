import { describe, expect, it } from 'vitest';
import {
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS,
  GATEWAY_CHAIN_NAMES,
  chainLabel,
  deployedChainIds,
  type CctpChainName,
} from '@ctrl-arcz/sdk';
import { chainsFor, labelOf, needsWalletOn, type ChainPurpose } from '../src/chainCatalog.js';
import { supportsChain } from '../src/chainSupport.js';

/**
 * Which networks a job can be done on.
 *
 * The rule being pinned here is that this file composes the registries rather than
 * restating them: every list has to be derivable from `CCTP_CHAINS`,
 * `GATEWAY_CHAIN_NAMES` and the deployment registry, so adding a chain is a data
 * change and never an edit here. The thing that made these tests necessary was a
 * second, hand-written chain table that had drifted -- five Gateway chains where
 * Circle serves eleven, and ids Circle does not use.
 */

const PURPOSES: ChainPurpose[] = [
  'protectedSend',
  'receive',
  'privatePay',
  'subscriptions',
  'cctpSource',
  'cctpDestination',
  'gatewayDeposit',
  'gatewaySource',
  'gatewayDestination',
];

describe('chainsFor', () => {
  it('never offers a network the job cannot be done on', () => {
    // The whole premise of the redesign: an unusable chain is absent, not greyed
    // out and not behind a "switch networks" screen. So for every one of our own
    // features, every chain offered must actually support it.
    for (const purpose of ['protectedSend', 'receive', 'privatePay', 'subscriptions'] as const) {
      for (const name of chainsFor(purpose)) {
        expect(supportsChain(CCTP_CHAINS[name].chainId, purpose)).toBe(true);
      }
    }
  });

  it('offers every chain that does support the job, not a subset somebody typed', () => {
    // The inverse, which is the half a hand-written list gets wrong: a chain we
    // deployed to and then forgot to add to a picker is invisible for no reason.
    for (const purpose of ['protectedSend', 'receive', 'privatePay', 'subscriptions'] as const) {
      const offered = new Set(chainsFor(purpose));
      for (const chainId of deployedChainIds()) {
        if (!supportsChain(chainId, purpose)) continue;
        const name = (Object.keys(CCTP_CHAINS) as CctpChainName[]).find(
          (n) => CCTP_CHAINS[n].chainId === chainId,
        );
        expect(name && offered.has(name)).toBe(true);
      }
    }
  });

  it('does not gate CCTP on our own deployments', () => {
    /*
     * Bridging is Circle's, not ours: no contract of ours is involved, so a chain
     * we have never deployed to bridges perfectly well. Filtering these by the
     * deployment registry would refuse fifteen of the twenty for a reason that
     * does not apply to them.
     */
    expect(chainsFor('cctpSource')).toHaveLength(Object.keys(CCTP_CHAINS).length);
    expect(chainsFor('cctpDestination')).toHaveLength(Object.keys(CCTP_CHAINS).length);
    expect(chainsFor('cctpSource').length).toBeGreaterThan(deployedChainIds().length);
  });

  it('offers exactly the chains Circle runs Gateway on', () => {
    // Not a copy of that list: the same list. The table this replaced had five.
    for (const purpose of ['gatewayDeposit', 'gatewaySource', 'gatewayDestination'] as const) {
      expect([...chainsFor(purpose)].sort()).toEqual([...GATEWAY_CHAIN_NAMES].sort());
    }
    expect(GATEWAY_CHAIN_NAMES.length).toBe(11);
  });

  it('puts Arc first wherever Arc is on offer', () => {
    // Where every contract lives, and the answer to "put me back".
    for (const purpose of PURPOSES) {
      const list = chainsFor(purpose);
      const arc = list.find((n) => CCTP_CHAINS[n].chainId === ARC_TESTNET_CHAIN_ID);
      if (arc) expect(list[0]).toBe(arc);
    }
  });

  it('returns names the chain registry actually knows', () => {
    /*
     * The failure that motivated deleting the old table: it named
     * `Optimism_Sepolia` and `Polygon_Amoy_Testnet`, while Circle calls them
     * `OP_Sepolia` and `Polygon_Amoy`. A lookup for either missed silently, so the
     * two entries most likely to be looked up were the two guaranteed to fail.
     */
    for (const purpose of PURPOSES) {
      for (const name of chainsFor(purpose)) {
        expect(CCTP_CHAINS[name]).toBeDefined();
      }
    }
  });

  it('lists each chain once', () => {
    for (const purpose of PURPOSES) {
      const list = chainsFor(purpose);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe('needsWalletOn', () => {
  it('asks for the wallet only where something is signed on that chain', () => {
    // A CCTP burn leaves the wallet, a Gateway deposit is a transaction, and our
    // own contracts are reached through a client pinned to the connected chain.
    for (const purpose of [
      'cctpSource',
      'gatewayDeposit',
      'protectedSend',
      'receive',
      'privatePay',
      'subscriptions',
    ] as const) {
      expect(needsWalletOn(purpose)).toBe(true);
    }
  });

  it('does not move the wallet for a Gateway source', () => {
    /*
     * The expensive mistake to get wrong in the permissive direction. A Gateway
     * spend is one signature over an intent whose EIP-712 domain names no chain;
     * there is no source-chain transaction at all. Prompting MetaMask when
     * somebody picks a source network would be a wallet popup that buys nothing
     * and interrupts the form it appears over.
     */
    expect(needsWalletOn('gatewaySource')).toBe(false);
    // Destinations are the other side of the same fact: nothing is signed there.
    expect(needsWalletOn('cctpDestination')).toBe(false);
    expect(needsWalletOn('gatewayDestination')).toBe(false);
  });
});

describe('labelOf', () => {
  it('is the one rule, and it is the registry’s', () => {
    // There were two, and the second one existed only to be fallen back from.
    for (const name of Object.keys(CCTP_CHAINS) as CctpChainName[]) {
      expect(labelOf(name)).toBe(chainLabel(name));
    }
  });

  it('reads the chains whose old hand-written labels used the wrong id', () => {
    expect(labelOf('OP_Sepolia')).toBe('OP Sepolia');
    expect(labelOf('Polygon_Amoy')).toBe('Polygon Amoy');
  });
});
