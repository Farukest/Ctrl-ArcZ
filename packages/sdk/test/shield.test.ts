import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, type Address } from 'viem';
import { spendDigest, spendTypedData, ownerHash, vaultHash, ACTION_PAY, ACTION_PULL } from '../src/shield/digest.js';

// Authoritative EIP-712 vector emitted by the Solidity test
// (SpendPolicyAccount.t.sol::test_LOG_eip712Vector). If the TS encoding ever
// drifts from the contract, this breaks. account/target/chainId/digest are the
// exact values the deployed clone hashes.
const VEC = {
  account: '0x27d1E74A3070828C14e72596BC0bF382177Cd04c' as Address,
  target: '0x00655EA989254C13e93C5a1F74C4636b5B9926B5' as Address,
  chainId: 31337,
  amount: 1_000_000n,
  nonce: 0n,
  digest: '0x751eb0a257fa191b915f997896458233320cd5d125922e3b1cb183927df241ef',
};

describe('shield digest — cross-checked against Solidity', () => {
  it('spendDigest matches the exact EIP-712 digest SpendPolicyAccount produces', () => {
    const got = spendDigest({
      account: VEC.account,
      chainId: VEC.chainId,
      target: VEC.target,
      amount: VEC.amount,
      nonce: VEC.nonce,
      action: ACTION_PAY,
    });
    expect(got).toBe(VEC.digest);
  });

  it('nonce changes the digest (replay-safe)', () => {
    const base = { account: VEC.account, chainId: VEC.chainId, target: VEC.target, amount: VEC.amount, action: ACTION_PAY } as const;
    expect(spendDigest({ ...base, nonce: 0n })).not.toBe(spendDigest({ ...base, nonce: 1n }));
  });

  it('account and chainId bind the digest (no cross-account/chain replay)', () => {
    const base = { target: VEC.target, amount: VEC.amount, nonce: VEC.nonce, action: ACTION_PAY } as const;
    const a = spendDigest({ ...base, account: VEC.account, chainId: VEC.chainId });
    const b = spendDigest({ ...base, account: '0x0000000000000000000000000000000000000c33' as Address, chainId: VEC.chainId });
    const c = spendDigest({ ...base, account: VEC.account, chainId: 1 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('action tag binds the digest (a pay auth cannot be a pull auth)', () => {
    const base = { account: VEC.account, chainId: VEC.chainId, target: VEC.target, amount: VEC.amount, nonce: VEC.nonce } as const;
    expect(spendDigest({ ...base, action: ACTION_PAY })).not.toBe(spendDigest({ ...base, action: ACTION_PULL }));
  });

  it('an EIP-712 signature over the typed data recovers to the signer (matches the contract check)', async () => {
    const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const typed = spendTypedData({
      account: VEC.account,
      chainId: VEC.chainId,
      target: VEC.target,
      amount: VEC.amount,
      nonce: VEC.nonce,
      action: ACTION_PAY,
    });
    const signature = await signer.signTypedData(typed);
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it('ownerHash / vaultHash are one-way commitments, not the raw address', () => {
    const addr = '0x00655EA989254C13e93C5a1F74C4636b5B9926B5' as Address;
    const oh = ownerHash(addr);
    // keccak256(abi.encode(address)) is 32 bytes and not the left-padded address
    expect(oh).toMatch(/^0x[0-9a-f]{64}$/);
    expect(oh).not.toBe(`0x000000000000000000000000${addr.slice(2).toLowerCase()}`);
    // owner and vault commitments of the same address are equal (same scheme),
    // but distinct addresses give distinct commitments
    expect(vaultHash(addr)).toBe(oh);
    expect(ownerHash('0x0000000000000000000000000000000000000c33' as Address)).not.toBe(oh);
  });
});
