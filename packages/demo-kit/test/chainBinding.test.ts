import { describe, it, expect } from 'vitest';
import { ARC_TESTNET_CHAIN_ID, CCTP_CHAINS, cctpChainByChainId, GATEWAY_CHAIN_NAMES, type CctpChainName } from '@ctrl-arcz/sdk';
import { chainForWallet, destinationChain, walletChainName } from '../src/chainBinding.js';

const CCTP: readonly CctpChainName[] = Object.keys(CCTP_CHAINS) as CctpChainName[];
const set = (options: readonly CctpChainName[] = CCTP) => ({
  options,
  chainIdOf: (name: CctpChainName) => CCTP_CHAINS[name].chainId,
});
const id = (name: CctpChainName) => CCTP_CHAINS[name].chainId;

describe('chainForWallet', () => {
  /**
   * The bug this whole module exists for. Every chain control on these screens
   * opened on 'Arc_Testnet' and never looked at the wallet, so a wallet on Ethereum
   * Sepolia met a form denominated in a network it was not on.
   */
  it('stands where the wallet stands', () => {
    expect(chainForWallet(set(), id('Ethereum_Sepolia'), undefined, 'Arc_Testnet')).toBe(
      'Ethereum_Sepolia',
    );
    expect(chainForWallet(set(), id('Base_Sepolia'), 'Arc_Testnet', 'Arc_Testnet')).toBe(
      'Base_Sepolia',
    );
  });

  /** The wallet outranks a stale selection, which is what makes this event-driven:
   *  a switch made in MetaMask itself lands here as a new chain id. */
  it('overrules what the control was showing when the wallet moves', () => {
    expect(chainForWallet(set(), id('Avalanche_Fuji'), 'Base_Sepolia', 'Arc_Testnet')).toBe(
      'Avalanche_Fuji',
    );
  });

  /**
   * A wallet on a chain this control does not serve is not a reason to throw away a
   * deliberate choice. Someone on Polygon Amoy who picked Base as their Gateway
   * source meant it, and Gateway spends need no particular network.
   */
  it('keeps a choice the wallet cannot answer for', () => {
    const gateway = set(GATEWAY_CHAIN_NAMES);
    expect(chainForWallet(gateway, id('Linea_Sepolia'), 'Base_Sepolia', 'Arc_Testnet')).toBe(
      'Base_Sepolia',
    );
  });

  it('falls back only when there is nothing else to stand on', () => {
    const gateway = set(GATEWAY_CHAIN_NAMES);
    expect(chainForWallet(gateway, id('Linea_Sepolia'), undefined, 'Arc_Testnet')).toBe(
      'Arc_Testnet',
    );
    expect(chainForWallet(gateway, undefined, undefined, 'Arc_Testnet')).toBe('Arc_Testnet');
  });

  /**
   * Narrowing the list is what switching to the Gateway engine does. A source that
   * is no longer served has to give way, and the caller's `onChange` then clears
   * the balances it read for it -- which is the whole reason this returns a change
   * rather than leaving the picker showing something the engine cannot use.
   */
  it('gives up a selection the list no longer offers', () => {
    const gateway = set(GATEWAY_CHAIN_NAMES);
    expect(GATEWAY_CHAIN_NAMES).not.toContain('Linea_Sepolia');
    expect(chainForWallet(gateway, undefined, 'Linea_Sepolia' as CctpChainName, 'Arc_Testnet')).toBe(
      'Arc_Testnet',
    );
  });

  /** An unknown network is a real state: any chain in the user's wallet. */
  it('treats a chain we have no entry for as no answer', () => {
    expect(chainForWallet(set(), 999_999, 'Base_Sepolia', 'Arc_Testnet')).toBe('Base_Sepolia');
    expect(chainForWallet(set(), 999_999, undefined, 'Arc_Testnet')).toBe('Arc_Testnet');
  });
});

describe('destinationChain', () => {
  /** Arc is where every contract in this app lives, so it is where money is
   *  usually coming to. This is the half of the screen that does not follow the
   *  wallet, which is exactly why it needs a rule of its own. */
  it('brings money home by default', () => {
    expect(destinationChain(CCTP, 'Ethereum_Sepolia', null, 'Arc_Testnet')).toBe('Arc_Testnet');
    expect(destinationChain(CCTP, 'Base_Sepolia', null, 'Arc_Testnet')).toBe('Arc_Testnet');
  });

  /** A route from a chain to itself is not a bridge. */
  it('steps aside when the money is already leaving home', () => {
    const to = destinationChain(CCTP, 'Arc_Testnet', null, 'Arc_Testnet');
    expect(to).not.toBe('Arc_Testnet');
    expect(CCTP).toContain(to);
  });

  it('keeps an explicit choice over the default', () => {
    expect(destinationChain(CCTP, 'Arc_Testnet', 'Linea_Sepolia', 'Arc_Testnet')).toBe(
      'Linea_Sepolia',
    );
    expect(destinationChain(CCTP, 'Base_Sepolia', 'Avalanche_Fuji', 'Arc_Testnet')).toBe(
      'Avalanche_Fuji',
    );
  });

  /**
   * Until it becomes impossible. Two ways: the source moves onto it (the swap
   * button, or a wallet switch), and the engine narrows the list.
   */
  it('drops a choice that has become the source', () => {
    expect(destinationChain(CCTP, 'Avalanche_Fuji', 'Avalanche_Fuji', 'Arc_Testnet')).toBe(
      'Arc_Testnet',
    );
  });

  it('drops a choice the engine no longer serves', () => {
    expect(
      destinationChain(GATEWAY_CHAIN_NAMES, 'Base_Sepolia', 'Linea_Sepolia' as never, 'Arc_Testnet'),
    ).toBe('Arc_Testnet');
  });

  /** Never the same chain at both ends, whatever it is asked. */
  it('never returns the source while another chain exists', () => {
    for (const from of CCTP) {
      for (const chosen of [null, from, 'Arc_Testnet' as CctpChainName]) {
        expect(destinationChain(CCTP, from, chosen, 'Arc_Testnet')).not.toBe(from);
      }
    }
  });
});

describe('walletChainName', () => {
  it('names the chain a wallet reports, and only one we have an entry for', () => {
    expect(walletChainName(ARC_TESTNET_CHAIN_ID)).toBe('Arc_Testnet');
    expect(walletChainName(id('Base_Sepolia'))).toBe('Base_Sepolia');
    expect(walletChainName(999_999)).toBeUndefined();
    expect(walletChainName(undefined)).toBeUndefined();
  });

  /** The lookup is built from the table, so it cannot fall behind it. */
  it('is the exact inverse of the chain table', () => {
    for (const name of CCTP) expect(cctpChainByChainId(CCTP_CHAINS[name].chainId)).toBe(name);
  });
});
