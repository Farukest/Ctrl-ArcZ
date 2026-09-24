import type { Chain } from 'viem';
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_MAINNET_RPC_URLS,
  ARC_TESTNET_CHAIN_ID,
  RPC_URLS,
  SIGNING_RPC_URLS,
  arcMainnet,
  arcTestnet,
  cctpChainByChainId,
  chainExplorerTxUrl,
  isTestnetChain,
} from '@ctrl-arcz/sdk';

/**
 * Which network this app runs on: one per build, never both on one screen.
 *
 * The SDK knows both networks and every chain in it says which one it belongs to.
 * An app has to pick, because a picker that offers Base next to Base Sepolia is a
 * picker that lets somebody bridge real money into a testnet contract that Circle
 * will never attest. So every list the app shows is narrowed to this network, and
 * "Arc" means this network's Arc.
 *
 * `VITE_NETWORK=testnet` builds the testnet app; anything else, including nothing,
 * builds mainnet. On a server (no Vite) there is no build flag and this reads as
 * mainnet, but the server does not use it to decide anything: it serves whichever
 * chain a request names.
 */
export type AppNetwork = 'mainnet' | 'testnet';

function readNetwork(): AppNetwork {
  let flag: string | undefined;
  try {
    // Written out in full so Vite replaces it at build time.
    flag = (import.meta as { env?: { VITE_NETWORK?: string } }).env?.VITE_NETWORK;
  } catch {
    flag = undefined;
  }
  // Node has no `import.meta.env`; a test or a script sets the variable instead.
  if (flag === undefined && typeof process !== 'undefined') flag = process.env?.VITE_NETWORK;
  return flag === 'testnet' ? 'testnet' : 'mainnet';
}

export const APP_NETWORK: AppNetwork = readNetwork();
export const APP_TESTNET = APP_NETWORK === 'testnet';

/** This network's Arc. */
export const APP_ARC_CHAIN_ID: number = APP_TESTNET ? ARC_TESTNET_CHAIN_ID : ARC_MAINNET_CHAIN_ID;

/** Whether a chain belongs to this app's network. False for one Circle does not serve. */
export function onAppNetwork(chainId: number | undefined): boolean {
  return chainId !== undefined && isTestnetChain(chainId) === APP_TESTNET;
}

/** One Arc's viem chain and its endpoints, read and signing. */
export interface ArcNetwork {
  chainId: number;
  chain: Chain;
  readRpcs: readonly string[];
  /**
   * Endpoints for a client that prepares transactions. On testnet the order
   * differs from the read list (two endpoints refuse `eth_fillTransaction`); on
   * mainnet Circle's own endpoint leads both.
   */
  signingRpcs: readonly string[];
}

const ARC_NETWORKS: Readonly<Record<number, ArcNetwork>> = {
  [ARC_TESTNET_CHAIN_ID]: {
    chainId: ARC_TESTNET_CHAIN_ID,
    chain: arcTestnet,
    readRpcs: RPC_URLS,
    signingRpcs: SIGNING_RPC_URLS,
  },
  [ARC_MAINNET_CHAIN_ID]: {
    chainId: ARC_MAINNET_CHAIN_ID,
    chain: arcMainnet as Chain,
    readRpcs: ARC_MAINNET_RPC_URLS,
    signingRpcs: ARC_MAINNET_RPC_URLS,
  },
};

/** Arc on a given network, by chain id. Undefined for a chain that is not Arc. */
export function arcNetwork(chainId: number): ArcNetwork | undefined {
  return ARC_NETWORKS[chainId];
}

/** This app's Arc. */
export const APP_ARC: ArcNetwork = ARC_NETWORKS[APP_ARC_CHAIN_ID]!;

/** This network's Arc, by the name every chain-keyed table in the SDK uses. */
export const APP_ARC_NAME: 'Arc' | 'Arc_Testnet' = APP_TESTNET ? 'Arc_Testnet' : 'Arc';

/**
 * A transaction link on a chain, from Circle's explorer template for it. Falls back
 * to this app's Arc, never to the SDK's built-in testnet explorer: on a mainnet
 * build that link opens a page saying the transaction does not exist.
 */
export function txLink(hash: string, chainId: number = APP_ARC_CHAIN_ID): string {
  const name = cctpChainByChainId(chainId) ?? APP_ARC_NAME;
  // Circle publishes an explorer for both Arcs, so the last fallback always resolves.
  return chainExplorerTxUrl(name, hash) ?? chainExplorerTxUrl(APP_ARC_NAME, hash)!;
}
