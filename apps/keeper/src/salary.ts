import { erc20Abi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import {
  ADDRESSES,
  ACTION_PULL,
  MODE_PULL,
  RemoteCoSigner,
  readAccount,
  submitPull,
  arcTestnet,
} from '@ctrl-arcz/sdk';
import { decideSalary } from './decide.js';

const USDC = ADDRESSES.USDC as Address;

/**
 * How the keeper pays for itself.
 *
 * It is not handed a funded wallet and trusted to be careful with it. It is paid
 * the way this product pays any recurring payee: from a `SpendPolicyAccount` in
 * PULL mode whose policy lives on chain — target locked to the keeper, a per-pull
 * ceiling, a minimum interval, a total budget, an expiry. The keeper proves
 * control of its own address to the co-signer, the co-signer re-reads that policy
 * from chain and signs or vetoes, and the contract enforces the caps regardless
 * of what either of them decided.
 *
 * So the keeper's blast radius is a number the operator chose and can read back
 * from chain, and revoking it is one `sweepToVault` from the operator's wallet —
 * a call the keeper cannot make, because that one *is* gated on `msg.sender`.
 */

export interface SalaryOutcome {
  pulled: boolean;
  amount?: bigint;
  txHash?: Hex;
  reason?: string;
}

export async function drawSalary(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  keeper: Address;
  box: Address;
  cosignUrl: string;
  cosignerAddress: Address;
  balance: bigint;
  lowWater: bigint;
  targetBalance: bigint;
  signMessage: (message: string) => Promise<Hex>;
  now?: number;
}): Promise<SalaryOutcome> {
  const state = await readAccount(params.publicClient, params.box);

  // Refuse to touch a box that is not the one described. A PUSH box has no pull
  // path, and a box pointing anywhere but the keeper would mean the operator
  // configured someone else's subscription here by mistake.
  if (state.mode !== MODE_PULL) return { pulled: false, reason: 'salary box is not a PULL box' };
  if (state.target.toLowerCase() !== params.keeper.toLowerCase()) {
    return { pulled: false, reason: 'salary box does not pay this keeper' };
  }

  const boxBalance = (await params.publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [params.box],
  })) as bigint;

  const now = params.now ?? Math.floor(Date.now() / 1000);
  const verdict = decideSalary({
    balance: params.balance,
    lowWater: params.lowWater,
    targetBalance: params.targetBalance,
    perPullMax: state.perPullMax,
    remaining: state.remaining,
    boxBalance,
    nextPullAt: state.lastPull === 0 ? now : state.lastPull + state.interval,
    nowSeconds: now,
  });
  if (!verdict.pull) return { pulled: false, reason: verdict.reason };
  if (now > state.expiry) return { pulled: false, reason: 'salary box has expired' };

  const cosigner = new RemoteCoSigner(params.cosignUrl, params.cosignerAddress, undefined, {
    address: params.keeper,
    sign: params.signMessage,
  });

  const auth = await cosigner.authorize({
    account: params.box,
    owner: params.keeper,
    amount: verdict.amount,
    action: ACTION_PULL,
    target: state.target,
    nonce: state.nonce,
    chainId: arcTestnet.id,
    remaining: state.remaining,
    expiry: state.expiry,
    perPullMax: state.perPullMax,
    interval: state.interval,
    lastPull: state.lastPull,
  });
  if (!auth.approved) return { pulled: false, reason: `co-signer vetoed: ${auth.reason}` };

  const txHash = await submitPull(
    { publicClient: params.publicClient, walletClient: params.walletClient },
    params.box,
    verdict.amount,
    auth.signature,
  );
  return { pulled: true, amount: verdict.amount, txHash };
}
