import { keccak256, encodeAbiParameters, toBytes, type Address, type Hex } from 'viem';

/**
 * Digest builders for `SpendPolicyAccount`, mirroring the contract byte-for-byte.
 *
 * The account requires signatures over a struct hash that binds `address(this)`,
 * the locked `target`, the `amount`, the current `nonce` and `chainId`. Binding
 * the account address and chain makes a signature un-replayable across accounts
 * or chains; the nonce makes it un-replayable within one account. The account
 * then verifies `ECDSA.recover(toEthSignedMessageHash(structHash), sig)`, so a
 * wallet signs the struct hash as a personal_sign message (`{ raw: structHash }`).
 */

const ACTION_TYPEHASH = keccak256(
  toBytes('SpendPolicyAction(address account,address target,uint256 amount,uint256 nonce,uint256 chainId)'),
);
const SWEEP_TYPEHASH = keccak256(
  toBytes('SpendPolicySweep(address account,address vault,uint256 nonce,uint256 chainId)'),
);

export interface PayDigestParams {
  account: Address;
  target: Address;
  amount: bigint;
  nonce: bigint;
  chainId: bigint;
}

/**
 * The 32-byte struct hash a wallet/enclave signs (via `signMessage({ message: { raw } })`)
 * to authorize paying/pulling `amount` from `account` to its locked target.
 */
export function payStructHash(p: PayDigestParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [ACTION_TYPEHASH, p.account, p.target, p.amount, p.nonce, p.chainId],
    ),
  );
}

export interface SweepDigestParams {
  account: Address;
  vault: Address;
  nonce: bigint;
  chainId: bigint;
}

/** The struct hash the owner signs to sweep an account back to its vault. */
export function sweepStructHash(p: SweepDigestParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
      [SWEEP_TYPEHASH, p.account, p.vault, p.nonce, p.chainId],
    ),
  );
}
