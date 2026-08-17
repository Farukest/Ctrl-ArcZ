import { erc20Abi, parseEther, parseUnits, type Address, type Hex } from 'viem';
import {
  announceStealthBox,
  createEphemeral,
  deploymentFor,
  announceArgsFor,
  type ChainDeployment,
  type EphemeralPolicy,
} from '@ctrl-arcz/sdk';
import { signerFor } from './session.js';

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
 *
 * Every entry point now names a chain. It used to be Arc by construction -- the
 * factory address, the announcer address and the signer were all module constants
 * -- and once a second deployment existed that stopped being an assumption and
 * became a bug waiting for a caller: the relayer would have deployed an Arc box
 * for a payment happening on Base, at an address the co-signer never authorised.
 */

/** The deployment, or a refusal naming the chain. Never a silent fall back to Arc. */
function on(chainId: number): ChainDeployment {
  const deployment = deploymentFor(chainId);
  if (!deployment) throw new Error(`no deployment on chain ${chainId}`);
  return deployment;
}

export async function relayCreateBox(
  privateKey: Hex,
  chainId: number,
  salt: Hex,
  policy: EphemeralPolicy,
): Promise<{ account: Address; txHash: Hex }> {
  const deployment = on(chainId);
  return createEphemeral(
    signerFor(chainId, privateKey),
    deployment.spendPolicyFactory,
    salt,
    policy,
  );
}

export async function relayAnnounceBox(
  privateKey: Hex,
  chainId: number,
  stealth: { stealthAddress: Address; ephemeralPubKey: Hex },
  box: Address,
  label = '',
): Promise<{ txHash: Hex }> {
  const deployment = on(chainId);
  const txHash = await announceStealthBox(
    signerFor(chainId, privateKey),
    deployment.stealthAnnouncer,
    announceArgsFor(stealth, box, label),
  );
  return { txHash };
}

/** Whether a box already exists on chain, so the relayer is never spent announcing
 *  an address that points at nothing. */
export async function boxExists(
  privateKey: Hex,
  chainId: number,
  box: Address,
): Promise<boolean> {
  const { publicClient } = signerFor(chainId, privateKey);
  const code = await publicClient.getCode({ address: box });
  return Boolean(code && code !== '0x');
}

/**
 * Enough for a stealth address to pay for its own sweep.
 *
 * Two figures, because gas is two different things. On Arc it is USDC, so the
 * top-up is an ERC-20 transfer of a few cents. Everywhere else it is the chain's
 * own coin, so the top-up is a plain value send -- and sending USDC there would
 * leave the stealth address holding a token it cannot spend, still unable to move
 * anything, with the relayer's money gone.
 */
export const STEALTH_GAS_TOPUP = parseUnits('0.05', 6);
/** Native gas, on chains that bill in their own coin. Generous on a testnet: the
 *  sweep is one transfer, and being short is an address that cannot be emptied. */
export const STEALTH_NATIVE_TOPUP = parseEther('0.001');

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
  chainId: number,
  to: Address,
): Promise<{ txHash: Hex | null; funded: boolean }> {
  const deployment = on(chainId);
  const { publicClient, walletClient } = signerFor(chainId, privateKey);

  if (deployment.gasToken === 'usdc') {
    const balance = (await publicClient.readContract({
      address: deployment.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [to],
    })) as bigint;
    if (balance >= STEALTH_GAS_TOPUP) return { txHash: null, funded: false };

    const txHash = await walletClient.writeContract({
      address: deployment.usdc,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, STEALTH_GAS_TOPUP],
      account: walletClient.account!,
      chain: walletClient.chain ?? null,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, funded: true };
  }

  const balance = await publicClient.getBalance({ address: to });
  if (balance >= STEALTH_NATIVE_TOPUP) return { txHash: null, funded: false };

  const txHash = await walletClient.sendTransaction({
    to,
    value: STEALTH_NATIVE_TOPUP,
    account: walletClient.account!,
    chain: walletClient.chain ?? null,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, funded: true };
}
