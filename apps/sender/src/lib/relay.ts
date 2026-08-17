import type { Address, Hex } from 'viem';
import { deploymentFor, predictEphemeral, type EphemeralPolicy } from '@ctrl-arcz/sdk';
import { bridgeClients, getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import { ARC_TESTNET_CHAIN_ID } from '@ctrl-arcz/sdk';
import { signedPost } from './signedPost.js';

/**
 * Deploy and announce a stealth box through the relayer instead of the payer's own
 * wallet.
 *
 * A box costs three transactions: deploy, fund, announce. Only funding has to come
 * from the payer, because only funding moves their money. The other two carried the
 * payer's address purely because the browser happened to submit them, and
 * `StealthAnnouncer` indexes `msg.sender`, so the announcement was the loudest link
 * of the three. Routing both through the relayer removes them.
 *
 * This does not make a subscription unlinkable on its own: the funding transfer
 * still runs from the payer's wallet to the box in the clear. What it does is
 * remove the two links that would remain public even after Arc's APS lands, since
 * an APS transaction is still submitted by a public sender who pays public gas.
 *
 * The relayer learns who asked (the request is signed, so it can be quota-limited).
 * It is trusted not to log that; it is not trusted with funds, and it cannot be:
 * neither call it makes can move USDC.
 */

/**
 * Reading the chain the wallet is actually on.
 *
 * Arc has our own RPCs; every other chain is reachable through the wallet's own
 * provider, which is by definition on the chain the user is on. Verifying the
 * relayer's answer against Arc while the box is on Base would compare an address to
 * a prediction from the wrong factory and reject every honest deploy.
 */
function clientOn(session: Session) {
  return session.chainId === ARC_TESTNET_CHAIN_ID
    ? getPublicClient()
    : bridgeClients(session.chainId, session.address).publicClient;
}

/** The factory on the wallet's chain. Throws rather than defaulting: a prediction
 *  from the wrong factory is a check that always fails. */
function factoryOn(session: Session): Address {
  const deployment = deploymentFor(session.chainId);
  if (!deployment) throw new Error(`Ctrl+ArcZ is not deployed on chain ${session.chainId}`);
  return deployment.spendPolicyFactory;
}

/** Bigints do not survive JSON, and the server re-derives the policy from these
 *  named fields rather than trusting calldata. */
function wire(policy: EphemeralPolicy) {
  return {
    token: policy.token,
    owner: policy.owner,
    cosigner: policy.cosigner,
    vault: policy.vault,
    target: policy.target,
    maxAmount: policy.maxAmount.toString(),
    perPullMax: (policy.perPullMax ?? 0n).toString(),
    expiry: policy.expiry,
    interval: policy.interval,
    mode: policy.mode,
  };
}

/**
 * Deploy the box and, in the same request, publish the announcement that makes it
 * findable. One signature for one user action, instead of one per relayed half.
 */
export async function relayCreateBox(
  session: Session,
  salt: Hex,
  policy: EphemeralPolicy,
  announce?: { stealthAddress: Address; ephemeralPubKey: Hex; label?: string },
): Promise<{ account: Address; txHash: Hex }> {
  const result = await signedPost<{ account: Address; txHash: Hex }>(session, '/api/relay/create', {
    salt,
    // Which chain the box belongs on. Sent explicitly rather than left to the
    // server's default: the relayer deploys where it is told, and a box deployed on
    // Arc for a payment happening on Base is at an address the co-signer never
    // authorised.
    chainId: session.chainId,
    policy: wire(policy),
    ...(announce
      ? {
          announce: {
            stealthAddress: announce.stealthAddress,
            ephemeralPubKey: announce.ephemeralPubKey,
            // Travels with the box so the name is the same on every device. The
            // relayer publishes it; it never sees who the payer is.
            ...(announce.label ? { label: announce.label } : {}),
          },
        }
      : {}),
  });

  // Verify locally rather than trusting the answer. The CREATE2 address commits to
  // the full policy, so an address that matches our own prediction cannot be a box
  // with a substituted target, cosigner, cap or vault.
  const read = clientOn(session);
  const expected = await predictEphemeral(read, factoryOn(session), salt, policy);
  if (result.account.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('relayer returned a box that is not the one we asked for');
  }
  const code = await read.getCode({ address: expected });
  if (!code || code === '0x') throw new Error('relayer did not deploy the box');

  return { account: expected, txHash: result.txHash };
}

export async function relayAnnounceBox(
  session: Session,
  stealth: { stealthAddress: Address; ephemeralPubKey: Hex },
  box: Address,
): Promise<Hex> {
  const { txHash } = await signedPost<{ txHash: Hex }>(session, '/api/relay/announce', {
    chainId: session.chainId,
    stealthAddress: stealth.stealthAddress,
    ephemeralPubKey: stealth.ephemeralPubKey,
    box,
  });
  return txHash;
}

/**
 * Give a stealth address enough gas to pay for its own sweep.
 *
 * A fresh stealth address cannot move anything until someone funds it, and doing
 * that from the payer's wallet was the worst link in the whole design: it wrote
 * `payer -> stealthAddress` on chain, and the stealth address is exactly what the
 * announcement records. The relayer sends it instead.
 *
 * What "gas" is differs by chain -- USDC on Arc, the chain's own coin elsewhere --
 * and the server decides which from the registry. The client only says where.
 */
export async function relayStealthGas(
  session: Session,
  to: Address,
): Promise<{ txHash: Hex | null; funded: boolean }> {
  return signedPost<{ txHash: Hex | null; funded: boolean }>(session, '/api/relay/gas', {
    chainId: session.chainId,
    to,
  });
}
