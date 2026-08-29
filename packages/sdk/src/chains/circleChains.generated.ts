/**
 * Circle's testnets, generated. Do not edit.
 *
 * Written by `scripts/generate-chains.mjs` out of `@circle-fin/bridge-kit`, which
 * is the same table Circle's own App Kit answers `getSupportedChains` from. Run the
 * script after bumping that dependency; `chainTable.test.ts` fails if this file and
 * the installed kit disagree, so the two cannot drift quietly.
 *
 * Generated from @circle-fin/bridge-kit@1.14.0.
 */

/** One of Circle's testnets, as much of it as this app has any use for. */
export interface GeneratedChain {
  /** This project's name for it, which is Circle's except for three aliases. */
  readonly name: string;
  /** Circle's own name, where it differs. Undefined when the two agree. */
  readonly circleName?: string;
  /** CCTP domain id. Not a chain id; the two are unrelated numbers. */
  readonly domain: number;
  readonly chainId: number;
  readonly usdc: `0x${string}`;
  /** True where Circle runs Gateway, which is a smaller set than CCTP. */
  readonly gateway: boolean;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  /** The explorer's front page, or undefined where Circle publishes none. */
  readonly explorerUrl?: string;
  /** Circle's link template, with {hash} where the transaction hash goes. */
  readonly explorerTx?: string;
  /** Every endpoint Circle publishes, resellers included. For reading. */
  readonly rpcEndpoints: readonly string[];
  /**
   * The chain's own endpoint, or undefined where it publishes none of its own.
   * The only kind that may be written into a wallet.
   */
  readonly firstPartyRpc?: string;
}

export const GENERATED_CHAINS = [
  {
    name: 'Ethereum_Sepolia',
    domain: 0,
    chainId: 11155111,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    gateway: true,
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://sepolia.etherscan.io',
    explorerTx: 'https://sepolia.etherscan.io/tx/{hash}',
    rpcEndpoints: ['https://ethereum-sepolia-rpc.publicnode.com'],
  },
  {
    name: 'Avalanche_Fuji',
    domain: 1,
    chainId: 43113,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
    gateway: true,
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    explorerUrl: 'https://subnets-test.avax.network/c-chain',
    explorerTx: 'https://subnets-test.avax.network/c-chain/tx/{hash}',
    rpcEndpoints: ['https://api.avax-test.network/ext/bc/C/rpc'],
    firstPartyRpc: 'https://api.avax-test.network/ext/bc/C/rpc',
  },
  {
    name: 'OP_Sepolia',
    circleName: 'Optimism_Sepolia',
    domain: 2,
    chainId: 11155420,
    usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    gateway: true,
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://sepolia-optimistic.etherscan.io',
    explorerTx: 'https://sepolia-optimistic.etherscan.io/tx/{hash}',
    rpcEndpoints: ['https://sepolia.optimism.io'],
    firstPartyRpc: 'https://sepolia.optimism.io',
  },
  {
    name: 'Arbitrum_Sepolia',
    domain: 3,
    chainId: 421614,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    gateway: true,
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://sepolia.arbiscan.io',
    explorerTx: 'https://sepolia.arbiscan.io/tx/{hash}',
    rpcEndpoints: ['https://sepolia-rollup.arbitrum.io/rpc'],
    firstPartyRpc: 'https://sepolia-rollup.arbitrum.io/rpc',
  },
  {
    name: 'Base_Sepolia',
    domain: 6,
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    gateway: true,
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://sepolia.basescan.org',
    explorerTx: 'https://sepolia.basescan.org/tx/{hash}',
    rpcEndpoints: ['https://sepolia.base.org'],
    firstPartyRpc: 'https://sepolia.base.org',
  },
  {
    name: 'Polygon_Amoy',
    circleName: 'Polygon_Amoy_Testnet',
    domain: 7,
    chainId: 80002,
    usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    gateway: true,
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    explorerUrl: 'https://amoy.polygonscan.com',
    explorerTx: 'https://amoy.polygonscan.com/tx/{hash}',
    rpcEndpoints: ['https://polygon-amoy-bor-rpc.publicnode.com', 'https://polygon-amoy.drpc.org'],
  },
  {
    name: 'Unichain_Sepolia',
    domain: 10,
    chainId: 1301,
    usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F',
    gateway: true,
    nativeCurrency: { name: 'Sepolia Uni', symbol: 'UNI', decimals: 18 },
    explorerUrl: 'https://unichain-sepolia.blockscout.com',
    explorerTx: 'https://unichain-sepolia.blockscout.com/tx/{hash}',
    rpcEndpoints: ['https://sepolia.unichain.org'],
    firstPartyRpc: 'https://sepolia.unichain.org',
  },
  {
    name: 'Linea_Sepolia',
    domain: 11,
    chainId: 59141,
    usdc: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7',
    gateway: false,
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://sepolia.lineascan.build',
    explorerTx: 'https://sepolia.lineascan.build/tx/{hash}',
    rpcEndpoints: ['https://rpc.sepolia.linea.build'],
    firstPartyRpc: 'https://rpc.sepolia.linea.build',
  },
  {
    name: 'Codex_Testnet',
    domain: 12,
    chainId: 812242,
    usdc: '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f',
    gateway: false,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://explorer.codex-stg.xyz',
    explorerTx: 'https://explorer.codex-stg.xyz/tx/{hash}',
    rpcEndpoints: ['https://rpc.codex-stg.xyz'],
    firstPartyRpc: 'https://rpc.codex-stg.xyz',
  },
  {
    name: 'Sonic_Testnet',
    domain: 13,
    chainId: 14601,
    usdc: '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51',
    gateway: true,
    nativeCurrency: { name: 'Sonic', symbol: 'S', decimals: 18 },
    explorerUrl: 'https://testnet.sonicscan.org',
    explorerTx: 'https://testnet.sonicscan.org/tx/{hash}',
    rpcEndpoints: ['https://rpc.testnet.soniclabs.com'],
    firstPartyRpc: 'https://rpc.testnet.soniclabs.com',
  },
  {
    name: 'World_Chain_Sepolia',
    domain: 14,
    chainId: 4801,
    usdc: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88',
    gateway: true,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://sepolia.worldscan.org',
    explorerTx: 'https://sepolia.worldscan.org/tx/{hash}',
    rpcEndpoints: ['https://worldchain-sepolia.drpc.org', 'https://worldchain-sepolia.g.alchemy.com/public'],
  },
  {
    name: 'Monad_Testnet',
    domain: 15,
    chainId: 10143,
    usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
    gateway: false,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    explorerUrl: 'https://testnet.monadscan.com',
    explorerTx: 'https://testnet.monadscan.com/tx/{hash}',
    rpcEndpoints: ['https://testnet-rpc.monad.xyz'],
    firstPartyRpc: 'https://testnet-rpc.monad.xyz',
  },
  {
    name: 'Sei_Testnet',
    domain: 16,
    chainId: 1328,
    usdc: '0x4fCF1784B31630811181f670Aea7A7bEF803eaED',
    gateway: true,
    nativeCurrency: { name: 'Sei', symbol: 'SEI', decimals: 18 },
    explorerUrl: 'https://testnet.seiscan.io',
    explorerTx: 'https://testnet.seiscan.io/tx/{hash}',
    rpcEndpoints: ['https://evm-rpc-testnet.sei-apis.com'],
    firstPartyRpc: 'https://evm-rpc-testnet.sei-apis.com',
  },
  {
    name: 'XDC_Apothem',
    domain: 18,
    chainId: 51,
    usdc: '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4',
    gateway: false,
    nativeCurrency: { name: 'TXDC', symbol: 'TXDC', decimals: 18 },
    explorerUrl: 'https://testnet.xdcscan.com',
    explorerTx: 'https://testnet.xdcscan.com/tx/{hash}',
    rpcEndpoints: ['https://erpc.apothem.network'],
    firstPartyRpc: 'https://erpc.apothem.network',
  },
  {
    name: 'HyperEVM_Testnet',
    domain: 19,
    chainId: 998,
    usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab',
    gateway: true,
    nativeCurrency: { name: 'Hype', symbol: 'HYPE', decimals: 18 },
    explorerUrl: 'https://app.hyperliquid-testnet.xyz/explorer',
    explorerTx: 'https://app.hyperliquid-testnet.xyz/explorer/tx/{hash}',
    rpcEndpoints: ['https://rpc.hyperliquid-testnet.xyz/evm'],
    firstPartyRpc: 'https://rpc.hyperliquid-testnet.xyz/evm',
  },
  {
    name: 'Ink_Testnet',
    domain: 21,
    chainId: 763373,
    usdc: '0xFabab97dCE620294D2B0b0e46C68964e326300Ac',
    gateway: false,
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://explorer-sepolia.inkonchain.com',
    explorerTx: 'https://explorer-sepolia.inkonchain.com/tx/{hash}',
    rpcEndpoints: ['https://rpc-gel-sepolia.inkonchain.com', 'https://rpc-qnd-sepolia.inkonchain.com'],
    firstPartyRpc: 'https://rpc-gel-sepolia.inkonchain.com',
  },
  {
    name: 'Plume_Testnet',
    domain: 22,
    chainId: 98867,
    usdc: '0xcB5f30e335672893c7eb944B374c196392C19D18',
    gateway: false,
    nativeCurrency: { name: 'Plume', symbol: 'PLUME', decimals: 18 },
    explorerUrl: 'https://testnet-explorer.plume.org',
    explorerTx: 'https://testnet-explorer.plume.org/tx/{hash}',
    rpcEndpoints: ['https://testnet-rpc.plume.org'],
    firstPartyRpc: 'https://testnet-rpc.plume.org',
  },
  {
    name: 'Arc_Testnet',
    domain: 26,
    chainId: 5042002,
    usdc: '0x3600000000000000000000000000000000000000',
    gateway: true,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    explorerUrl: 'https://testnet.arcscan.app',
    explorerTx: 'https://testnet.arcscan.app/tx/{hash}',
    rpcEndpoints: ['https://rpc.testnet.arc.network'],
    firstPartyRpc: 'https://rpc.testnet.arc.network',
  },
  {
    name: 'Edge_Testnet',
    domain: 28,
    chainId: 33431,
    usdc: '0x2d9F7CAD728051AA35Ecdc472a14cf8cDF5CFD6B',
    gateway: false,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://edge-testnet.explorer.alchemy.com',
    explorerTx: 'https://edge-testnet.explorer.alchemy.com/tx/{hash}',
    rpcEndpoints: ['https://edge-testnet.g.alchemy.com/public'],
  },
  {
    name: 'Injective_Testnet',
    domain: 29,
    chainId: 1439,
    usdc: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d',
    gateway: false,
    nativeCurrency: { name: 'Injective', symbol: 'INJ', decimals: 18 },
    explorerUrl: 'https://testnet.explorer.injective.network',
    explorerTx: 'https://testnet.explorer.injective.network/transaction/{hash}',
    rpcEndpoints: ['https://k8s.testnet.json-rpc.injective.network'],
    firstPartyRpc: 'https://k8s.testnet.json-rpc.injective.network',
  },
  {
    name: 'Morph_Hoodi',
    circleName: 'Morph_Testnet',
    domain: 30,
    chainId: 2910,
    usdc: '0x7433b41C6c5e1d58D4Da99483609520255ab661B',
    gateway: false,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorerUrl: 'https://explorer-hoodi.morphl2.io',
    explorerTx: 'https://explorer-hoodi.morphl2.io/tx/{hash}',
    rpcEndpoints: ['https://rpc-hoodi.morphl2.io'],
    firstPartyRpc: 'https://rpc-hoodi.morphl2.io',
  },
  {
    name: 'Pharos_Testnet',
    domain: 31,
    chainId: 688689,
    usdc: '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B',
    gateway: false,
    nativeCurrency: { name: 'Pharos', symbol: 'PHAROS', decimals: 18 },
    explorerUrl: 'https://atlantic.pharosscan.xyz',
    explorerTx: 'https://atlantic.pharosscan.xyz/tx/{hash}',
    rpcEndpoints: ['https://atlantic.dplabs-internal.com'],
    firstPartyRpc: 'https://atlantic.dplabs-internal.com',
  },
  {
    name: 'Cronos_Testnet',
    domain: 32,
    chainId: 338,
    usdc: '0xEb33dc5fac03833e132593659e1dE7256aB59794',
    gateway: false,
    nativeCurrency: { name: 'CRO', symbol: 'tCRO', decimals: 18 },
    explorerUrl: 'https://explorer.cronos.org/testnet',
    explorerTx: 'https://explorer.cronos.org/testnet/tx/{hash}',
    rpcEndpoints: ['https://evm-t3.cronos.org'],
    firstPartyRpc: 'https://evm-t3.cronos.org',
  },
  {
    name: 'Plasma_Testnet',
    domain: 33,
    chainId: 9746,
    usdc: '0xE67Fb267022cBA8064Dd388CC2FED724F3120D9D',
    gateway: false,
    nativeCurrency: { name: 'Plasma', symbol: 'XPL', decimals: 18 },
    explorerUrl: 'https://testnet.plasmascan.to',
    explorerTx: 'https://testnet.plasmascan.to/tx/{hash}',
    rpcEndpoints: ['https://testnet-rpc.plasma.to'],
    firstPartyRpc: 'https://testnet-rpc.plasma.to',
  },
  {
    name: 'X_Layer_Testnet',
    domain: 37,
    chainId: 1952,
    usdc: '0xDec90b78111Ba2fc6FC6d84d8B9ec159A2d4b9B3',
    gateway: false,
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    explorerUrl: 'https://web3.okx.com/explorer/x-layer-testnet',
    explorerTx: 'https://web3.okx.com/explorer/x-layer-testnet/tx/{hash}',
    rpcEndpoints: ['https://testrpc.xlayer.tech'],
    firstPartyRpc: 'https://testrpc.xlayer.tech',
  },
] as const satisfies readonly GeneratedChain[];
