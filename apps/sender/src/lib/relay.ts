import type { Address, Hex } from 'viem';
import { predictEphemeral, SPEND_POLICY_FACTORY_ADDRESS, type EphemeralPolicy } from '@ctrl-arcz/sdk';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
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
  const expected = await predictEphemeral(
    getPublicClient(),
    SPEND_POLICY_FACTORY_ADDRESS,
    salt,
    policy,
  );
  if (result.account.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('relayer returned a box that is not the one we asked for');
  }
  const code = await getPublicClient().getCode({ address: expected });
  if (!code || code === '0x') throw new Error('relayer did not deploy the box');

  return { account: expected, txHash: result.txHash };
}

export async function relayAnnounceBox(
  session: Session,
  stealth: { stealthAddress: Address; ephemeralPubKey: Hex },
  box: Address,
): Promise<Hex> {
  const { txHash } = await signedPost<{ txHash: Hex }>(session, '/api/relay/announce', {
    stealthAddress: stealth.stealthAddress,
    ephemeralPubKey: stealth.ephemeralPubKey,
    box,
  });
  return txHash;
}

/**
 * Give a stealth address enough USDC to pay for its own sweep.
 *
 * Gas on Arc is USDC, so a fresh stealth address cannot move anything until someone
 * funds it. Doing that from the payer's wallet was the worst link in the whole
 * design: it wrote `payer -> stealthAddress` on chain, and the stealth address is
 * exactly what the announcement records. The relayer sends it instead.
 */
export async function relayStealthGas(
  session: Session,
  to: Address,
): Promise<{ txHash: Hex | null; funded: boolean }> {
  return signedPost<{ txHash: Hex | null; funded: boolean }>(session, '/api/relay/gas', { to });
}
