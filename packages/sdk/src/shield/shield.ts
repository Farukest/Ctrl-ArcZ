import { type Address, type Hex, type PublicClient, type WalletClient, type Account } from 'viem';
import { spendPolicyFactoryAbi, spendPolicyAccountAbi, vaultAbi } from './abi.js';
import { ownerHash as toOwnerHash, vaultHash as toVaultHash, ACTION_PAY } from './digest.js';
import type { CoSigner } from './cosigner.js';

/**
 * The payer-side shield integration surface. A few generic calls let a wallet,
 * onramp or checkout create a disposable, policy-bound payment address, fund it,
 * and settle it under the enclave co-signer's veto — without exposing the payer or
 * the vault to the merchant.
 *
 * The account stores no payer identity: the owner is bound only through the salt
 * (`ownerHash`) and the return address only through `vaultHash`. A spend needs
 * only the co-signer's signature; the payer signs nothing here.
 */

export const MODE_PUSH = 0 as const;
export const MODE_PULL = 1 as const;
export type SpendMode = typeof MODE_PUSH | typeof MODE_PULL;

export interface ShieldClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
}

function requireAccount(walletClient: WalletClient): Account | Address {
  const account = walletClient.account;
  if (!account) throw new Error('walletClient has no account');
  return account;
}

// ------------------------------------------------------------------
// Ephemeral account lifecycle
// ------------------------------------------------------------------

export interface EphemeralPolicy {
  token: Address;
  /** Bound only as a hash (the salt). Never written to the account. */
  owner: Address;
  cosigner: Address;
  /** Bound only as a commitment. Its address is revealed only at sweep. */
  vault: Address;
  target: Address;
  maxAmount: bigint;
  /** PULL only: max per single pull. 0 means "no tighter cap than maxAmount". */
  perPullMax?: bigint;
  /** Unix seconds. No outbound payment after this. */
  expiry: number;
  /** PULL only: min seconds between pulls. 0 for PUSH. */
  interval: number;
  mode: SpendMode;
}

/** The deterministic address `createEphemeral` will occupy — fund it before it exists. */
export async function predictEphemeral(
  publicClient: PublicClient,
  factory: Address,
  owner: Address,
  salt: Hex,
): Promise<Address> {
  return publicClient.readContract({
    address: factory,
    abi: spendPolicyFactoryAbi,
    functionName: 'predictAddress',
    args: [toOwnerHash(owner), salt],
  }) as Promise<Address>;
}

/**
 * Deploy + initialize the disposable account. Returns its (predicted) address.
 * Anyone may submit this (the address is bound to `ownerHash`, not to msg.sender),
 * so an integrator can deploy it through a relayer to keep the payer off the
 * deployment transaction entirely.
 */
export async function createEphemeral(
  clients: ShieldClients,
  factory: Address,
  salt: Hex,
  policy: EphemeralPolicy,
): Promise<{ account: Address; txHash: Hex }> {
  const sender = requireAccount(clients.walletClient);
  const predicted = await predictEphemeral(clients.publicClient, factory, policy.owner, salt);
  const txHash = await clients.walletClient.writeContract({
    address: factory,
    abi: spendPolicyFactoryAbi,
    functionName: 'createAccount',
    args: [
      toOwnerHash(policy.owner),
      salt,
      {
        token: policy.token,
        cosigner: policy.cosigner,
        vaultHash: toVaultHash(policy.vault),
        target: policy.target,
        maxAmount: policy.maxAmount,
        perPullMax: policy.perPullMax ?? 0n,
        expiry: policy.expiry,
        interval: policy.interval,
        mode: policy.mode,
      },
    ],
    account: sender,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { account: predicted, txHash };
}

/** Fund an ephemeral account from the vault (owner only). The APS-confidential leg. */
export async function fundFromVault(
  clients: ShieldClients,
  vault: Address,
  account: Address,
  amount: bigint,
): Promise<Hex> {
  const owner = requireAccount(clients.walletClient);
  const txHash = await clients.walletClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'fundAccount',
    args: [account, amount],
    account: owner,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

// ------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------

export interface AccountState {
  nonce: bigint;
  spent: bigint;
  remaining: bigint;
  target: Address;
  perPullMax: bigint;
  expiry: number;
  mode: SpendMode;
}

/** Getter-first read of an account (no reliance on event logs — APS-ready). This
 *  is the authoritative policy source; the co-signer validates against it. */
export async function readAccount(publicClient: PublicClient, account: Address): Promise<AccountState> {
  const at = { address: account, abi: spendPolicyAccountAbi } as const;
  const [nonce, spent, remaining, target, perPullMax, expiry, mode] = await Promise.all([
    publicClient.readContract({ ...at, functionName: 'nonce' }),
    publicClient.readContract({ ...at, functionName: 'spent' }),
    publicClient.readContract({ ...at, functionName: 'remaining' }),
    publicClient.readContract({ ...at, functionName: 'target' }),
    publicClient.readContract({ ...at, functionName: 'perPullMax' }),
    publicClient.readContract({ ...at, functionName: 'expiry' }),
    publicClient.readContract({ ...at, functionName: 'mode' }),
  ]);
  return {
    nonce,
    spent,
    remaining,
    target,
    perPullMax,
    expiry: Number(expiry),
    mode: mode as SpendMode,
  };
}

// ------------------------------------------------------------------
// Settlement
// ------------------------------------------------------------------

/** Submit a PUSH payment with the co-signer signature. Anyone may submit
 *  (relayer-safe); the funds are locked to the target and cap. */
export async function submitPay(
  clients: ShieldClients,
  account: Address,
  amount: bigint,
  cosignerSig: Hex,
): Promise<Hex> {
  const sender = requireAccount(clients.walletClient);
  const txHash = await clients.walletClient.writeContract({
    address: account,
    abi: spendPolicyAccountAbi,
    functionName: 'pay',
    args: [amount, cosignerSig],
    account: sender,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/** Submit a PULL with the co-signer signature. */
export async function submitPull(
  clients: ShieldClients,
  account: Address,
  amount: bigint,
  cosignerSig: Hex,
): Promise<Hex> {
  const sender = requireAccount(clients.walletClient);
  const txHash = await clients.walletClient.writeContract({
    address: account,
    abi: spendPolicyAccountAbi,
    functionName: 'pull',
    args: [amount, cosignerSig],
    account: sender,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/** Sweep the account home to its vault. Gated by knowledge of the vault (the
 *  preimage of the stored commitment), so no signature is needed. */
export async function sweepToVault(clients: ShieldClients, account: Address, vault: Address): Promise<Hex> {
  const sender = requireAccount(clients.walletClient);
  const txHash = await clients.walletClient.writeContract({
    address: account,
    abi: spendPolicyAccountAbi,
    functionName: 'sweepToVault',
    args: [vault],
    account: sender,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/** Sweep an expired account back to its vault (keeper/refund path). */
export async function sweepExpired(clients: ShieldClients, account: Address, vault: Address): Promise<Hex> {
  const sender = requireAccount(clients.walletClient);
  const txHash = await clients.walletClient.writeContract({
    address: account,
    abi: spendPolicyAccountAbi,
    functionName: 'sweepExpired',
    args: [vault],
    account: sender,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

// ------------------------------------------------------------------
// High-level: private checkout in one call
// ------------------------------------------------------------------

export interface PrivatePayResult {
  account: Address;
  txHash: Hex;
}

export type PrivatePayOutcome =
  | { ok: true; result: PrivatePayResult }
  | { ok: false; vetoed: true; reason: string; riskReasons?: string[] };

/**
 * One-call private checkout for a PUSH account that already exists and is funded:
 * read the on-chain policy, ask the co-signer to authorize (it may VETO), then
 * settle with its signature alone. The merchant only ever sees the ephemeral
 * address; the payer signs nothing.
 */
export async function settlePrivatePayment(
  clients: ShieldClients,
  account: Address,
  amount: bigint,
  cosigner: CoSigner,
  ctx: { owner: Address },
): Promise<PrivatePayOutcome> {
  const state = await readAccount(clients.publicClient, account);
  const chainId = await clients.publicClient.getChainId();

  const auth = await cosigner.authorize({
    account,
    owner: ctx.owner,
    amount,
    action: ACTION_PAY,
    target: state.target,
    nonce: state.nonce,
    chainId,
    remaining: state.remaining,
    expiry: state.expiry,
  });
  if (!auth.approved) {
    return {
      ok: false,
      vetoed: true,
      reason: auth.reason,
      ...(auth.riskReasons ? { riskReasons: auth.riskReasons } : {}),
    };
  }

  const txHash = await submitPay(clients, account, amount, auth.signature);
  return { ok: true, result: { account, txHash } };
}
