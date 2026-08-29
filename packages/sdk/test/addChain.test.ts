import { describe, expect, it } from 'vitest';
import {
  CCTP_CHAINS,
  GATEWAY_CHAIN_NAMES,
  addChainParams,
  canAddChain,
  chainLabel,
  chainNativeCurrency,
  firstPartyRpc,
  readRpcUrls,
  type CctpChainName,
} from '../src/index.js';

/**
 * What the app is allowed to tell a wallet when it asks it to add a network.
 *
 * The screen used to say "Sonic Testnet is not in your wallet yet. Add the network,
 * then try again", which is a dead end wearing the clothes of an instruction: it
 * asks somebody to go and find a chain id, an endpoint and a currency symbol for a
 * network the app already knows all three of.
 *
 * The reason it said that was sound and is kept. Adding a network means naming an
 * RPC endpoint that the user then trusts with every request they make on that chain
 * afterwards, so the rule is that nothing in the request may be invented. These
 * tests are that rule, written down: the endpoints have to be the ones already
 * proven for reads, the currency has to come from a published registry, and a chain
 * missing either has to produce no offer at all rather than a filled-in blank.
 *
 * Which chains that works out to is therefore data rather than a decision, and it
 * is expected to change when the tables change. What must not change is that a
 * chain we cannot describe honestly is one the user is asked to add themselves.
 */

const ALL = Object.keys(CCTP_CHAINS) as CctpChainName[];

describe('addChainParams', () => {
  it('builds a request only out of facts the app already holds', () => {
    for (const chain of ALL) {
      const id = CCTP_CHAINS[chain].chainId;
      const params = addChainParams(id);
      if (!params) continue;

      // The id the wallet checks, in the hex the method is specified in.
      expect(params.chainId, chain).toBe(`0x${id.toString(16)}`);
      // The same name the rest of the app uses. A wallet showing a different one
      // than the picker the user just clicked is a different network as far as
      // they can tell.
      expect(params.chainName, chain).toBe(chainLabel(chain));
      // The chain's own endpoint, and only that one. Not the read list, which
      // carries community proxies that are right for this app to dial and wrong
      // to leave in a wallet.
      expect(params.rpcUrls, chain).toEqual([firstPartyRpc(chain)]);
      expect(params.nativeCurrency, chain).toEqual(chainNativeCurrency(chain));
    }
  });

  it('never puts a third party in somebody’s wallet', () => {
    /*
     * The rule this file exists for, stated as a list of who must not be in it.
     *
     * An endpoint the app dials for a balance is used once and the answer is
     * checked against a contract. An endpoint stored in a wallet is used by every
     * other site the user visits on that chain, for as long as it stays there, and
     * whoever runs it sees all of it. The read lists are full of these and are
     * right to be; this must contain none of them.
     */
    const THIRD_PARTIES = [
      'publicnode.com',
      'drpc.org',
      'alchemy.com',
      'tenderly.co',
      'thirdweb.com',
      'infura.io',
      'quiknode.pro',
      'ankr.com',
      'blastapi.io',
      'blockpi.network',
      'nodereal.io',
      'chainstack.com',
    ];
    for (const chain of ALL) {
      const params = addChainParams(CCTP_CHAINS[chain].chainId);
      if (!params) continue;
      for (const url of params.rpcUrls) {
        const host = new URL(url).host;
        for (const bad of THIRD_PARTIES) {
          expect(host.endsWith(bad), `${chain} would store ${host} in a wallet`).toBe(false);
        }
      }
    }
  });

  it('sends one endpoint and not a fallback list', () => {
    // A fallback here is a second party seeing the same traffic, which is the
    // thing being avoided rather than a resilience win.
    for (const chain of ALL) {
      const params = addChainParams(CCTP_CHAINS[chain].chainId);
      if (params) expect(params.rpcUrls.length, chain).toBe(1);
    }
  });

  it('offers nothing for a chain missing either fact', () => {
    for (const chain of ALL) {
      const id = CCTP_CHAINS[chain].chainId;
      const complete = chainNativeCurrency(chain) !== undefined && firstPartyRpc(chain) !== undefined;
      expect(canAddChain(id), `${chain} should ${complete ? '' : 'not '}be addable`).toBe(complete);
    }
  });

  it('can still read the chains it will not offer to add', () => {
    /*
     * The two questions came apart on purpose and this is the proof.
     *
     * Polygon Amoy's own `rpc-amoy.polygon.technology` stopped resolving in DNS,
     * World Chain Sepolia publishes nothing but Alchemy, Tenderly and thirdweb,
     * and Ethereum Sepolia never had a chain-owned endpoint. All three are read
     * perfectly well through the community endpoints in the read list, and a
     * balance the app reads for itself is not the same act as an endpoint left in
     * somebody's wallet for every other site to use.
     */
    for (const chain of ['Polygon_Amoy', 'World_Chain_Sepolia', 'Ethereum_Sepolia'] as const) {
      const id = CCTP_CHAINS[chain].chainId;
      expect(readRpcUrls(id).length, chain).toBeGreaterThan(0);
      expect(canAddChain(id), chain).toBe(false);
    }
  });

  it('is silent about chains it has never heard of', () => {
    // Not an exception and not an empty object: the caller has to be able to tell
    // "cannot offer" apart from "offer with nothing in it".
    expect(addChainParams(999_999_999)).toBeUndefined();
    expect(addChainParams(undefined)).toBeUndefined();
    expect(canAddChain(undefined)).toBe(false);
  });

  it('never ships an endpoint that is not https, or the same one twice', () => {
    // These go into a wallet's permanent network list. An http endpoint there is
    // every future request on that chain in the clear.
    for (const chain of ALL) {
      const params = addChainParams(CCTP_CHAINS[chain].chainId);
      if (!params) continue;
      expect(params.rpcUrls.length, chain).toBeGreaterThan(0);
      for (const u of params.rpcUrls) expect(u, `${chain}: ${u}`).toMatch(/^https:\/\//);
      expect(new Set(params.rpcUrls).size, chain).toBe(params.rpcUrls.length);
    }
  });

  it('omits the explorer rather than guessing one', () => {
    // Optional in EIP-3085 and optional here. A guessed explorer is a link that
    // goes somewhere else, which is worse in a wallet than no link at all: it is
    // stored, and every transaction on that chain is looked up through it.
    for (const chain of ALL) {
      const params = addChainParams(CCTP_CHAINS[chain].chainId);
      if (!params?.blockExplorerUrls) continue;
      for (const u of params.blockExplorerUrls) expect(u, chain).toMatch(/^https:\/\//);
    }
  });
});

describe('the currency table', () => {
  it('names a coin for every chain it names one for, with real decimals', () => {
    for (const chain of ALL) {
      const c = chainNativeCurrency(chain);
      if (!c) continue;
      expect(c.symbol.length, chain).toBeGreaterThan(0);
      expect(c.name.length, chain).toBeGreaterThan(0);
      // EIP-3085 takes decimals and wallets use them to render a balance. 18 is
      // what every chain here uses, including Arc, whose coin is USDC and whose
      // ERC-20 USDC has 6 -- those are two different things and this is the gas one.
      expect(c.decimals, chain).toBe(18);
    }
  });

  it('has no entry for the one chain nobody publishes', () => {
    // Morph Hoodi. Neither viem's registry nor chainid.network carries 2910, so
    // there is no honest symbol to send, and inventing one would put a made-up
    // coin name in a wallet's add dialog. The gap is the mechanism, not an
    // oversight: no entry means no offer.
    expect(chainNativeCurrency('Morph_Hoodi')).toBeUndefined();
  });
});

describe('the networks a bridge actually asks the wallet to stand on', () => {
  /*
   * The exact shape of the answer, written down rather than described.
   *
   * Sixteen of the twenty can be offered and four cannot, and the four are not a
   * policy: they are the chains where the published facts run out. Two have no
   * chain-owned endpoint left, one never had one, and one has no published coin.
   * A chain leaving or joining this list is a change worth noticing, which is why
   * it is pinned by name.
   */
  const NO_OFFER = ['Ethereum_Sepolia', 'Polygon_Amoy', 'World_Chain_Sepolia', 'Morph_Hoodi'];

  it('is exactly the chains whose own details are still published', () => {
    expect(ALL.filter((c) => !canAddChain(CCTP_CHAINS[c].chainId))).toEqual(NO_OFFER);
  });

  it('reaches every Gateway chain that is not already on that list', () => {
    // A Gateway deposit is a real transaction on the chosen chain, so this is the
    // set where being unable to switch stops the user dead. Read off the same list
    // rather than repeating three of its names.
    for (const chain of GATEWAY_CHAIN_NAMES) {
      expect(canAddChain(CCTP_CHAINS[chain].chainId), chain).toBe(!NO_OFFER.includes(chain));
    }
  });
});
