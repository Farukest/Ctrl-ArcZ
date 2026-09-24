import type { PublicClient } from 'viem';
import { deploymentFor } from '@ctrl-arcz/sdk';
import { bridgeClients, getPublicClient, type Session, APP_ARC_CHAIN_ID } from '@ctrl-arcz/demo-kit';

/**
 * Reading the chain the wallet is actually on.
 *
 * Arc has our own RPC list and is read through it. Every other chain is reached
 * through the wallet's own provider, which is by definition on the chain the user
 * is on -- one fewer thing to keep correct for twenty networks, and no endpoint
 * for the browser to trust that the user has not already trusted.
 *
 * This is here rather than repeated per screen because getting it wrong does not
 * throw. A read pointed at Arc for a payment on Base returns a real answer to a
 * different question: a contract that does not exist there looks empty, and an
 * address with Arc history looks familiar on a chain where it has done nothing.
 */
export function readClientFor(session: Session): PublicClient {
  return session.chainId === APP_ARC_CHAIN_ID
    ? getPublicClient()
    : (bridgeClients(session.chainId, session.address).publicClient as PublicClient);
}

/** The CtrlArcZ whose events the firewall reads for verified recipients. Throws
 *  on a chain with no deployment, which every screen has already refused. */
export function ctrlArcZFor(session: Session): `0x${string}` {
  const deployment = deploymentFor(session.chainId);
  if (!deployment) throw new Error(`Ctrl+ArcZ is not deployed on chain ${session.chainId}`);
  return deployment.ctrlArcZ;
}

/**
 * This app's Arc CtrlArcZ, for the readers that go through `getPublicClient()`
 * (incoming transfers, pending claims, claim-by-code). They were pinned to the
 * SDK's built-in address, which is testnet Arc's and has no code on mainnet.
 */
export function appCtrlArcZ(): `0x${string}` {
  const deployment = deploymentFor(APP_ARC_CHAIN_ID);
  if (!deployment) throw new Error(`no deployment on chain ${APP_ARC_CHAIN_ID}`);
  return deployment.ctrlArcZ;
}

/**
 * Where a lookback scan on this app's Arc should start: `lookback` blocks ago, but
 * never before the contract existed. On a fresh deployment (Arc mainnet) that is
 * the difference between a few requests and twenty.
 */
export function appScanStart(latest: bigint, lookback: bigint): bigint {
  const floor = deploymentFor(APP_ARC_CHAIN_ID)?.ctrlArcZDeployBlock ?? 0n;
  const back = latest > lookback ? latest - lookback : 0n;
  return back > floor ? back : floor;
}
