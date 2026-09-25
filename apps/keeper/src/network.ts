import 'dotenv/config';
import { fallback, http, type Address, type Chain } from 'viem';
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  arcMainnet,
  arcTestnet,
  deploymentFor,
  readRpcUrls,
} from '@ctrl-arcz/sdk';

/**
 * Which Arc the keeper works on, and every address that follows from it.
 *
 * Read from `KEEPER_CHAIN_ID` and resolved through the deployment table, never
 * through the SDK's bare constants: those are testnet Arc's, and a keeper that
 * fell back to them on mainnet would scan a contract that does not exist there
 * from a block the chain has not reached, find nothing, and report all clear.
 * Unset means testnet Arc, where the keeper was first run.
 */

const CHAINS: Record<number, Chain> = {
  [ARC_TESTNET_CHAIN_ID]: arcTestnet,
  [ARC_MAINNET_CHAIN_ID]: arcMainnet,
};

const chainId = Number(process.env.KEEPER_CHAIN_ID ?? ARC_TESTNET_CHAIN_ID);
const chain = CHAINS[chainId];
const deployment = deploymentFor(chainId);
if (!chain || !deployment) {
  throw new Error(`KEEPER_CHAIN_ID ${chainId} is not an Arc network with a deployment`);
}

export const network = {
  chain,
  chainId,
  usdc: deployment.usdc as Address,
  ctrlArcZ: deployment.ctrlArcZ as Address,
  spendPolicyFactory: deployment.spendPolicyFactory as Address,
  /** Nothing of ours exists before this block, so no scan starts earlier. */
  deployBlock: deployment.ctrlArcZDeployBlock,
  /** `KEEPER_RPC_URL` first when set (the server's Alchemy endpoint): the public
   *  endpoints rate-limit the log scans this process runs every tick. */
  rpcUrls: process.env.KEEPER_RPC_URL
    ? [process.env.KEEPER_RPC_URL, ...readRpcUrls(chainId)]
    : readRpcUrls(chainId),
};

export const transport = () => fallback(network.rpcUrls.map((u) => http(u, { retryCount: 2 })));
