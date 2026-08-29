/**
 * Circle's chain table, reduced to what this app uses.
 *
 * The derivation lives here rather than in the generator so that the generator and
 * the test that guards it read the same code. Two copies of "which endpoint counts
 * as first-party" would be two answers eventually, and the second one would be the
 * one nobody ran.
 *
 * Imports `@circle-fin/bridge-kit`, which is a devDependency: three megabytes of
 * Solana web3, ethers and pino, none of which belongs anywhere near a browser
 * bundle. Nothing under `src/` may import this.
 */
import { getAddress } from 'viem';
import * as bridgeKit from '@circle-fin/bridge-kit';

/**
 * Circle's name for a chain against ours, for the three where they differ.
 *
 * Ours came from Circle's CCTP references and theirs from the App Kit `Blockchain`
 * enum; both are Circle's, and they are the same chains by chain id, domain and
 * USDC address. Keeping ours is not stubbornness: these names are written into
 * stored activity rows in people's browsers, so renaming them orphans history.
 */
export const OUR_NAME = {
  Optimism_Sepolia: 'OP_Sepolia',
  Polygon_Amoy_Testnet: 'Polygon_Amoy',
  Morph_Testnet: 'Morph_Hoodi',
};

/**
 * Whoever resells access to a chain rather than being the chain.
 *
 * They are fine to read through and must never be written into a wallet, which is
 * the distinction `firstPartyRpc` exists to make. Circle's published list mixes
 * both, so it is filtered rather than trusted wholesale.
 */
export const RESELLERS = [
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

const isFirstParty = (url) => {
  const host = new URL(url).host;
  return !RESELLERS.some((r) => host === r || host.endsWith(`.${r}`));
};

/**
 * Circle publishes an explorer as a link template with `{hash}` in it, and the path
 * around it is not the same everywhere: most are `/tx/{hash}`, Injective's is
 * `/transaction/{hash}`, X Layer's sits under a per-chain path. The template is kept
 * whole because a tx link is what the app actually builds; the front page is the
 * easy half to derive from it, and gluing `/tx/` back onto one was wrong on two
 * chains.
 */
const explorerHome = (template) =>
  template
    ? template.replace(/\/(?:tx|transaction)?\/?\{hash\}.*$/, '').replace(/\/$/, '') || undefined
    : undefined;

const trim = (url) => url.replace(/\/$/, '');

/** Every EVM testnet Circle serves CCTP on, in domain order. */
export function deriveChains() {
  const defs = Object.values(bridgeKit)
    .filter(
      (v) =>
        v &&
        typeof v === 'object' &&
        v.type === 'evm' &&
        v.isTestnet === true &&
        typeof v.chainId === 'number' &&
        v.cctp &&
        typeof v.usdcAddress === 'string',
    )
    // By CCTP domain, which is the number Circle orders them by and the one that
    // does not move when a chain is renamed.
    .sort((a, b) => a.cctp.domain - b.cctp.domain);

  const out = [];
  const seen = new Set();
  for (const d of defs) {
    const name = OUR_NAME[d.chain] ?? d.chain;
    if (seen.has(name)) throw new Error(`two chains resolve to the name ${name}`);
    seen.add(name);

    const explorerUrl = explorerHome(d.explorerUrl);
    const firstPartyRpc = d.rpcEndpoints.find(isFirstParty);
    out.push({
      name,
      ...(d.chain === name ? {} : { circleName: d.chain }),
      domain: d.cctp.domain,
      chainId: d.chainId,
      usdc: getAddress(d.usdcAddress),
      gateway: Boolean(d.gateway),
      nativeCurrency: {
        name: d.nativeCurrency.name,
        symbol: d.nativeCurrency.symbol,
        decimals: d.nativeCurrency.decimals,
      },
      ...(explorerUrl ? { explorerUrl } : {}),
      ...(d.explorerUrl ? { explorerTx: d.explorerUrl } : {}),
      rpcEndpoints: d.rpcEndpoints.map(trim),
      ...(firstPartyRpc ? { firstPartyRpc: trim(firstPartyRpc) } : {}),
    });
  }
  return out;
}
