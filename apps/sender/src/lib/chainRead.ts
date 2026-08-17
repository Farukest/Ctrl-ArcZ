import type { PublicClient } from 'viem';
import { ARC_TESTNET_CHAIN_ID, deploymentFor } from '@ctrl-arcz/sdk';
import { bridgeClients, getPublicClient, type Session } from '@ctrl-arcz/demo-kit';

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
  return session.chainId === ARC_TESTNET_CHAIN_ID
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
