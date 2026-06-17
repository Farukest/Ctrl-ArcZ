import { erc20Abi, maxUint256, type Address, type Hex, type TypedDataDomain } from 'viem';
import { ADDRESSES } from '../chains/arcTestnet.js';
import type { ClientPair } from './transfer.js';

/**
 * Permit2 SignatureTransfer helpers. These let a sender authorise a single,
 * exact-amount USDC pull with an off-chain EIP-712 signature instead of a
 * per-send `approve` transaction. The one-time prerequisite is a single
 * `USDC.approve(PERMIT2, ...)`.
 *
 * The EIP-712 types and domain match Uniswap's Permit2 `PermitTransferFrom`.
 */

/** Permit2 has no version and a chain-scoped domain with no name in its EIP-712 domain separator... */
const PERMIT2_DOMAIN_NAME = 'Permit2';

export const PERMIT2_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

export interface Permit2Signature {
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

const permit2Domain = (chainId: number): TypedDataDomain => ({
  name: PERMIT2_DOMAIN_NAME,
  chainId,
  verifyingContract: ADDRESSES.PERMIT2,
});

/** Current USDC allowance the owner has granted to Permit2. */
export async function getPermit2Allowance(clients: ClientPair, owner: Address): Promise<bigint> {
  return clients.publicClient.readContract({
    address: ADDRESSES.USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, ADDRESSES.PERMIT2],
  });
}

/**
 * One-time approval of Permit2 to move the owner's USDC. After this, every send
 * needs only a signature. Returns null when the allowance already covers `amount`.
 * Many users already have this from other Permit2 apps.
 */
export async function approvePermit2(
  clients: ClientPair,
  amount: bigint = maxUint256,
): Promise<Hex | null> {
  const account = clients.walletClient.account;
  if (!account) throw new Error('walletClient has no account');
  const owner = account.address;

  const allowance = await getPermit2Allowance(clients, owner);
  if (allowance >= amount) return null;

  const hash = await clients.walletClient.writeContract({
    address: ADDRESSES.USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [ADDRESSES.PERMIT2, amount],
    account,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Signs a Permit2 `PermitTransferFrom` authorising `spender` to pull `amount`
 * USDC once. `nonce` is any unused 256-bit value; the SDK derives a random one.
 *
 * @param spender The contract that will call `permitTransferFrom` — CtrlArcZ.
 */
export async function signPermit2Transfer(
  clients: ClientPair,
  amount: bigint,
  spender: Address,
  options: { nonce?: bigint; deadlineSeconds?: number; now?: number } = {},
): Promise<Permit2Signature> {
  const account = clients.walletClient.account;
  if (!account) throw new Error('walletClient has no account');

  const chainId = clients.walletClient.chain?.id;
  if (!chainId) throw new Error('walletClient has no chain');

  const nonce = options.nonce ?? randomNonce();
  const nowSeconds = options.now ?? Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowSeconds + (options.deadlineSeconds ?? 3600));

  const signature = await clients.walletClient.signTypedData({
    account,
    domain: permit2Domain(chainId),
    types: PERMIT2_TYPES,
    primaryType: 'PermitTransferFrom',
    message: {
      permitted: { token: ADDRESSES.USDC, amount },
      spender,
      nonce,
      deadline,
    },
  });

  return { nonce, deadline, signature };
}

/** A random 256-bit unordered nonce. Permit2 tracks used nonces in a bitmap. */
function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
