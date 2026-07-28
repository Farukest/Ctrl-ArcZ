import { erc20Abi, parseUnits, type Address, type Hex } from 'viem';
import {
  ADDRESSES,
  announceStealthBox,
  createEphemeral,
  STEALTH_ANNOUNCER_ADDRESS,
  SPEND_POLICY_FACTORY_ADDRESS,
  announceArgsFor,
  type EphemeralPolicy,
} from '@ctrl-arcz/sdk';
import { localSigner } from './session.js';

/**
 * Server-only. Submits the two transactions of a stealth box's life that would
 * otherwise carry the payer's address, so they carry the relayer's instead.
 *
 * Neither call moves anyone's money: `createAccount` deploys a clone bound to
 * `ownerHash` (a hash of the stealth address, not of the payer), and `announce`
 * only emits an event. The relayer pays gas and nothing else, which is what makes
 * it safe to expose behind a signed, quota-limited endpoint.
 *
 * What this does NOT hide: funding. The payer still transfers USDC from their own
 * wallet into the box, and that transfer is a public link between the two. Closing
 * it needs the transfer itself to be confidential, which on Arc means APS (see
 * `docs/privacy.md`). Relaying these two is the part that stays necessary even
 * after APS lands, because the outer transaction's sender is public either way.
 */
export async function relayCreateBox(
  privateKey: Hex,
  salt: Hex,
  policy: EphemeralPolicy,
): Promise<{ account: Address; txHash: Hex }> {
  return createEphemeral(localSigner(privateKey), SPEND_POLICY_FACTORY_ADDRESS, salt, policy);
}

export async function relayAnnounceBox(
  privateKey: Hex,
  stealth: { stealthAddress: Address; ephemeralPubKey: Hex },
  box: Address,
): Promise<{ txHash: Hex }> {
  const txHash = await announceStealthBox(
    localSigner(privateKey),
    STEALTH_ANNOUNCER_ADDRESS,
    announceArgsFor(stealth, box),
  );
  return { txHash };
}

/** Whether a box already exists on chain, so the relayer is never spent announcing
 *  an address that points at nothing. */
export async function boxExists(privateKey: Hex, box: Address): Promise<boolean> {
  const { publicClient } = localSigner(privateKey);
  const code = await publicClient.getCode({ address: box });
  return Boolean(code && code !== '0x');
}

/** Enough USDC for a stealth address to pay for its own sweep. Gas on Arc is USDC,
 *  so a fresh stealth address is otherwise unable to move anything. */
export const STEALTH_GAS_TOPUP = parseUnits('0.05', 6);

/**
 * Top a stealth address up so it can sign its own sweep.
 *
 * This is the one relayed call that moves the relayer's own money, and it is the
 * one that matters most for privacy: before it existed, cancelling a subscription
 * meant sending gas straight from the payer's wallet to the stealth address, which
 * published the exact link the stealth address exists to avoid. The amount is
 * fixed and skipped when the address already has enough, so the most a caller can
 * extract is one top-up per unit of their daily quota.
 */
export async function relayStealthGas(
  privateKey: Hex,
  to: Address,
): Promise<{ txHash: Hex | null; funded: boolean }> {
  const { publicClient, walletClient } = localSigner(privateKey);
  const balance = (await publicClient.readContract({
    address: ADDRESSES.USDC as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [to],
  })) as bigint;
  if (balance >= STEALTH_GAS_TOPUP) return { txHash: null, funded: false };

  const txHash = await walletClient.writeContract({
    address: ADDRESSES.USDC as Address,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, STEALTH_GAS_TOPUP],
    account: walletClient.account!,
    chain: walletClient.chain ?? null,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, funded: true };
}
