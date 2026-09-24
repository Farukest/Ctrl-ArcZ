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

/**
 * Every EVM chain Circle serves CCTP on: the testnets first, then the mainnets,
 * each in domain order.
 *
 * Testnets first so the rows that existed before mainnet keep their place, and a
 * network is never inferred from position: every row says which one it is on.
 */
export function deriveChains() {
  const defs = Object.values(bridgeKit)
    .filter(
      (v) =>
        v &&
        typeof v === 'object' &&
        v.type === 'evm' &&
        typeof v.isTestnet === 'boolean' &&
        typeof v.chainId === 'number' &&
        v.cctp &&
        typeof v.usdcAddress === 'string',
    )
    // By CCTP domain, which is the number Circle orders them by and the one that
    // does not move when a chain is renamed.
    .sort((a, b) => Number(b.isTestnet) - Number(a.isTestnet) || a.cctp.domain - b.cctp.domain);

  const out = [];
  const seen = new Set();
  for (const d of defs) {
    const name = OUR_NAME[d.chain] ?? d.chain;
    if (seen.has(name)) throw new Error(`two chains resolve to the name ${name}`);
    seen.add(name);

    const explorerUrl = explorerHome(d.explorerUrl);
    const firstPartyRpc = d.rpcEndpoints.find(isFirstParty);
    // Circle deploys CCTP and Gateway with CREATE2, but not to one address on both
    // networks, and not even to one address on every mainnet (Edge differs). So the
    // contracts travel with the row instead of living in a constant.
    const cctpV2 = d.cctp.contracts?.v2;
    const gatewayV1 = d.gateway?.contracts?.v1;
    if (!cctpV2?.tokenMessenger || !cctpV2?.messageTransmitter) {
      throw new Error(`${d.chain}: no CCTP v2 contracts in the kit`);
    }
    if (d.gateway && (!gatewayV1?.wallet || !gatewayV1?.minter)) {
      throw new Error(`${d.chain}: Gateway listed without its contracts`);
    }
    out.push({
      name,
      ...(d.chain === name ? {} : { circleName: d.chain }),
      testnet: d.isTestnet,
      domain: d.cctp.domain,
      chainId: d.chainId,
      usdc: getAddress(d.usdcAddress),
      tokenMessenger: getAddress(cctpV2.tokenMessenger),
      messageTransmitter: getAddress(cctpV2.messageTransmitter),
      gateway: Boolean(d.gateway),
      ...(gatewayV1
        ? { gatewayWallet: getAddress(gatewayV1.wallet), gatewayMinter: getAddress(gatewayV1.minter) }
        : {}),
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
