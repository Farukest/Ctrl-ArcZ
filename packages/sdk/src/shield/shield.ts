import { type Address, type Hex, type PublicClient, type WalletClient, type Account } from 'viem';
import { spendPolicyFactoryAbi, spendPolicyAccountAbi, vaultAbi } from './abi.js';
import { payStructHash, sweepStructHash } from './digest.js';
import type { CoSigner } from './cosigner.js';

/**
 * The payer-side shield integration surface. A few generic calls let a wallet,
 * onramp or checkout create a disposable, policy-bound payment address, fund it
 * from a vault, and settle it under the 2-of-2 (owner + enclave) guard — without
 * exposing the vault to the merchant.
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
  owner: Address;
  cosigner: Address;
  vault: Address;
  target: Address;
  maxAmount: bigint;
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
    args: [owner, salt],
  }) as Promise<Address>;
}

/** Deploy + initialize the disposable account. Returns its (predicted) address. */
export async function createEphemeral(
  clients: ShieldClients,
  factory: Address,
  salt: Hex,
  policy: EphemeralPolicy,
): Promise<{ account: Address; txHash: Hex }> {
  const account = requireAccount(clients.walletClient);
  const predicted = await predictEphemeral(clients.publicClient, factory, policy.owner, salt);
  const txHash = await clients.walletClient.writeContract({
    address: factory,
    abi: spendPolicyFactoryAbi,
    functionName: 'createAccount',
    args: [
      salt,
      {
        token: policy.token,
        owner: policy.owner,
        cosigner: policy.cosigner,
        vault: policy.vault,
        target: policy.target,
        maxAmount: policy.maxAmount,
        expiry: policy.expiry,
        interval: policy.interval,
        mode: policy.mode,
      },
    ],
    account,
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
  expiry: number;
  mode: SpendMode;
}

/** Getter-first read of an account (no reliance on event logs — APS-ready). */
export async function readAccount(publicClient: PublicClient, account: Address): Promise<AccountState> {
  const at = { address: account, abi: spendPolicyAccountAbi } as const;
  const [nonce, spent, remaining, target, expiry, mode] = await Promise.all([
    publicClient.readContract({ ...at, functionName: 'nonce' }),
    publicClient.readContract({ ...at, functionName: 'spent' }),
    publicClient.readContract({ ...at, functionName: 'remaining' }),
    publicClient.readContract({ ...at, functionName: 'target' }),
    publicClient.readContract({ ...at, functionName: 'expiry' }),
    publicClient.readContract({ ...at, functionName: 'mode' }),
  ]);
  return { nonce, spent, remaining, target, expiry: Number(expiry), mode: mode as SpendMode };
}

// ------------------------------------------------------------------
// Signing + settlement
// ------------------------------------------------------------------

/** Owner signs the pay authorization for `amount` at the account's current nonce. */
export async function signOwnerPay(
  clients: ShieldClients,
  account: Address,
  amount: bigint,
): Promise<Hex> {
  const state = await readAccount(clients.publicClient, account);
  const chainId = BigInt(await clients.publicClient.getChainId());
  const hash = payStructHash({ account, target: state.target, amount, nonce: state.nonce, chainId });
  return clients.walletClient.signMessage({
    account: requireAccount(clients.walletClient),
    message: { raw: hash },
  });
}

/** Submit a PUSH payment with both signatures. Anyone may submit (relayer-safe). */
export async function submitPay(
  clients: ShieldClients,
  account: Address,
  amount: bigint,
  ownerSig: Hex,
  cosignerSig: Hex,
): Promise<Hex> {
  const sender = requireAccount(clients.walletClient);
  const txHash = await clients.walletClient.writeContract({
    address: account,
    abi: spendPolicyAccountAbi,
    functionName: 'pay',
    args: [amount, ownerSig, cosignerSig],
    account: sender,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/** Submit a PULL with the cosigner signature only. */
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

/** Owner sweeps the account home to its vault (works even if the enclave is gone). */
export async function sweepToVault(clients: ShieldClients, account: Address, vault: Address): Promise<Hex> {
  const owner = requireAccount(clients.walletClient);
  const state = await readAccount(clients.publicClient, account);
  const chainId = BigInt(await clients.publicClient.getChainId());
  const hash = sweepStructHash({ account, vault, nonce: state.nonce, chainId });
  const ownerSig = await clients.walletClient.signMessage({ account: owner, message: { raw: hash } });
  const txHash = await clients.walletClient.writeContract({
    address: account,
    abi: spendPolicyAccountAbi,
    functionName: 'sweepToVault',
    args: [ownerSig],
    account: owner,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/** Anyone sweeps an expired account back to its vault (keeper/refund path). */
export async function sweepExpired(clients: ShieldClients, account: Address): Promise<Hex> {
  const sender = requireAccount(clients.walletClient);
  const txHash = await clients.walletClient.writeContract({
    address: account,
    abi: spendPolicyAccountAbi,
    functionName: 'sweepExpired',
    args: [],
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
 * read nonce, owner-sign, ask the co-signer to authorize (it may VETO), then
 * settle. The merchant only ever sees the ephemeral address.
 */
export async function settlePrivatePayment(
  clients: ShieldClients,
  account: Address,
  amount: bigint,
  cosigner: CoSigner,
  ctx: { owner: Address; vault: Address },
): Promise<PrivatePayOutcome> {
  const state = await readAccount(clients.publicClient, account);
  const chainId = BigInt(await clients.publicClient.getChainId());

  const auth = await cosigner.authorize({
    account,
    owner: ctx.owner,
    target: state.target,
    amount,
    nonce: state.nonce,
    chainId,
    policy: { lockedTarget: state.target, remaining: state.remaining, expiry: state.expiry },
  });
  if (!auth.approved) {
    return { ok: false, vetoed: true, reason: auth.reason, ...(auth.riskReasons ? { riskReasons: auth.riskReasons } : {}) };
  }

  // Sign inline from the state we already read, rather than re-reading the account
  // (halves the RPC round-trips on the hot path — kinder to a rate-limited RPC).
  const hash = payStructHash({ account, target: state.target, amount, nonce: state.nonce, chainId });
  const ownerSig = await clients.walletClient.signMessage({
    account: requireAccount(clients.walletClient),
    message: { raw: hash },
  });
  const txHash = await submitPay(clients, account, amount, ownerSig, auth.signature);
  return { ok: true, result: { account, txHash } };
}
