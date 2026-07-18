import {
  hashTypedData,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem';

/**
 * EIP-712 typed-data builders for `SpendPolicyAccount`, mirroring the contract
 * byte-for-byte.
 *
 * The co-signer authorizes a spend by signing a `Spend(address target,uint256
 * amount,uint256 nonce,uint8 action)` struct. The domain binds `chainId` and
 * `verifyingContract = account`, so a signature is un-replayable across accounts
 * or chains; the nonce makes it un-replayable within one account; and `action`
 * (0 = pay, 1 = pull) keeps a pay authorization from ever standing in for a pull.
 *
 * Typed data (rather than a bare 32-byte hash) means any wallet that ever needs
 * to show one of these renders the fields — target, amount — instead of an opaque
 * hex blob. The payer never signs one of these at all: a spend needs only the
 * co-signer's signature, and the payer's sole action is a normal USDC transfer.
 */

export const SPEND_DOMAIN_NAME = 'Ctrl+ArcZ SpendPolicy';
export const SPEND_DOMAIN_VERSION = '1';

export const ACTION_PAY = 0 as const;
export const ACTION_PULL = 1 as const;
export type SpendAction = typeof ACTION_PAY | typeof ACTION_PULL;

export const SPEND_TYPES = {
  Spend: [
    { name: 'target', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'action', type: 'uint8' },
  ],
} as const;

export interface SpendDigestParams {
  /** The account; becomes the EIP-712 `verifyingContract`. */
  account: Address;
  /** The domain chainId. */
  chainId: number;
  target: Address;
  amount: bigint;
  nonce: bigint;
  action: SpendAction;
}

function domain(account: Address, chainId: number): TypedDataDomain {
  return {
    name: SPEND_DOMAIN_NAME,
    version: SPEND_DOMAIN_VERSION,
    chainId,
    verifyingContract: account,
  };
}

/** The full EIP-712 payload for `walletClient.signTypedData` / `account.signTypedData`. */
export function spendTypedData(p: SpendDigestParams) {
  return {
    domain: domain(p.account, p.chainId),
    types: SPEND_TYPES,
    primaryType: 'Spend' as const,
    message: { target: p.target, amount: p.amount, nonce: p.nonce, action: p.action },
  };
}

/** The final 32-byte EIP-712 digest — equals the account's `spendDigest(amount, action)`. */
export function spendDigest(p: SpendDigestParams): Hex {
  return hashTypedData(spendTypedData(p));
}

/**
 * Commitment helpers. The account stores no payer identity: the owner is bound
 * only through `ownerHash` (the CREATE2 salt) and the return address only through
 * `vaultHash`. Both are `keccak256(abi.encode(address))`, one-way — an observer
 * reading the account learns nothing, and only someone who already knows the
 * address can recompute the hash.
 */
export function ownerHash(owner: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }], [owner]));
}

export function vaultHash(vault: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }], [vault]));
}
