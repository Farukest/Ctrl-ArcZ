/**
 * Single source of truth for every Arc Testnet address, endpoint and chain
 * constant used anywhere in Ctrl+ArcZ (SDK, demo apps, Foundry deploy scripts).
 *
 * No address is hardcoded outside this file. Values are transcribed from the
 * Arc documentation, not from memory:
 *   - https://docs.arc.io/arc/references/contract-addresses
 *   - https://docs.arc.io/arc/references/connect-to-arc
 */
import { arcTestnet as viemArcTestnet } from 'viem/chains';

/** viem ships Arc Testnet as a built-in chain (requires viem >= 2.38). */
export const arcTestnet = viemArcTestnet;

export const ARC_TESTNET_CHAIN_ID = 5042002 as const;

export const RPC_URL = 'https://rpc.testnet.arc.network' as const;
export const WS_URL = 'wss://rpc.testnet.arc.network' as const;
export const EXPLORER_URL = 'https://testnet.arcscan.app' as const;

/**
 * Blockscout-compatible REST API exposed by ArcScan. The schema is not part of
 * the Arc docs; it was verified against the live API.
 */
export const EXPLORER_API_URL = `${EXPLORER_URL}/api/v2` as const;

export const FAUCET_URL = 'https://faucet.circle.com' as const;

/**
 * Arc contract addresses (Testnet).
 * Source: https://docs.arc.io/arc/references/contract-addresses
 */
export const ADDRESSES = {
  /**
   * USDC ERC-20 interface over the native balance. 6 decimals on this
   * interface, 18 on the native one — never mix the two. Ctrl+ArcZ only ever
   * touches the ERC-20 interface, and reads `decimals()` from the contract.
   */
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',

  /** Attaches memo metadata to a call; must be invoked directly by an EOA. */
  MEMO: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
  /** Multicall3 that preserves the original msg.sender in each subcall. */
  MULTICALL3_FROM: '0x522fAf9A91c41c443c66765030741e4AaCe147D0',

  /** Standard Ethereum-ecosystem contracts, predeployed on Arc. */
  MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  CREATE2_FACTORY: '0x4e59b44847b379578588920cA78FbF26c0B4956C',

  /** Crosschain (CCTP v2 / Gateway), Arc domain 26. Unused by Ctrl+ArcZ v1. */
  CCTP_TOKEN_MESSENGER_V2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  CCTP_MESSAGE_TRANSMITTER_V2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  GATEWAY_WALLET: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',

  /** StableFX settlement escrow. Unused by Ctrl+ArcZ v1. */
  FX_ESCROW: '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8',
} as const satisfies Record<string, `0x${string}`>;

/** Decimals of the USDC ERC-20 interface. Always cross-checked against `decimals()` at runtime. */
export const USDC_DECIMALS = 6 as const;

/** CCTP domain id for Arc. Source: contract-addresses.md */
export const ARC_CCTP_DOMAIN = 26 as const;

/**
 * Address seeded by Arc Testnet whose value transfers always revert, used to
 * exercise blocklist revert paths.
 * Source: https://docs.arc.io/arc/references/contract-addresses
 */
export const BLOCKLISTED_TEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

/**
 * CtrlArcZ deployment on Arc Testnet.
 * Written by `scripts/sync-deployment.mjs` from the Deploy.s.sol output — never
 * edited by hand. The zero address means "not deployed yet".
 */
export const CTRL_ARCZ_ADDRESS = '0x8dAb7148cdc31DAcad6d7e12161AA3DEDb572Dca' as `0x${string}`;
export const CODE_CLAIM_VERIFIER_ADDRESS =
  '0x2C0f268DE2Aa8BB2ab27F2Ea5Ae8a0f9a0E068c4' as `0x${string}`;

// Payer-side shield (deployed via DeployShield.s.sol on Arc Testnet).
export const SPEND_POLICY_FACTORY_ADDRESS =
  '0x8Be610e77D3ab629EA4Cd4CBA2097B8a16dD3808' as `0x${string}`;
export const SPEND_POLICY_ACCOUNT_IMPL_ADDRESS =
  '0xA75746F436bd9342F4434714A5121254B02Ad28f' as `0x${string}`;
export const SHIELD_VAULT_ADDRESS = '0xB3Cfd5c3b72b09351071E9C2023eD8DA2A76244C' as `0x${string}`;

/**
 * Block CtrlArcZ was deployed at. Event queries start here, never from 0: Arc's
 * RPC caps `eth_getLogs` at a 10,000-block range (error -32614), so a full-history
 * scan must be chunked from this block forward. See `getLogsChunked`.
 */
export const CTRL_ARCZ_DEPLOY_BLOCK = 51326557n;

/** Arc RPC hard limit on an `eth_getLogs` block range. */
export const MAX_LOG_RANGE = 10000n;

export const explorerTxUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddressUrl = (address: string) => `${EXPLORER_URL}/address/${address}`;
