import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress, type Address } from 'viem';
import { payStructHash, sweepStructHash } from '../src/shield/digest.js';

// Lowercase: identical bytes to the cast inputs (0A11/0B22), so the hash matches;
// viem rejects non-checksummed mixed case, and case does not affect the hash.
const ACCOUNT = '0x0000000000000000000000000000000000000a11' as Address;
const TARGET = '0x0000000000000000000000000000000000000b22' as Address;
const ARC_CHAIN_ID = 5042002n;

describe('shield digest — cross-checked against Solidity (cast)', () => {
  it('payStructHash matches the exact bytes SpendPolicyAccount hashes', () => {
    // Authoritative value produced by `cast keccak` over the same
    // abi.encode(TYPEHASH, account, target, amount, nonce, chainId) the contract
    // uses. If the TS encoding ever drifts from Solidity, this breaks.
    const expected = '0xde064e9ac2d5ac9f65c853bd4af90c1811080db0e89b85c15fa455ddee123bb9';
    const got = payStructHash({
      account: ACCOUNT,
      target: TARGET,
      amount: 1_000_000n,
      nonce: 0n,
      chainId: ARC_CHAIN_ID,
    });
    expect(got).toBe(expected);
  });

  it('nonce changes the digest (replay-safe)', () => {
    const base = { account: ACCOUNT, target: TARGET, amount: 1_000_000n, chainId: ARC_CHAIN_ID };
    expect(payStructHash({ ...base, nonce: 0n })).not.toBe(payStructHash({ ...base, nonce: 1n }));
  });

  it('account and chainId bind the digest (no cross-account/chain replay)', () => {
    const base = { target: TARGET, amount: 1_000_000n, nonce: 0n };
    const a = payStructHash({ ...base, account: ACCOUNT, chainId: ARC_CHAIN_ID });
    const b = payStructHash({
      ...base,
      account: '0x0000000000000000000000000000000000000c33' as Address,
      chainId: ARC_CHAIN_ID,
    });
    const c = payStructHash({ ...base, account: ACCOUNT, chainId: 1n });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('a wallet signature over the struct hash recovers to the signer (matches the contract check)', async () => {
    const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const hash = payStructHash({
      account: ACCOUNT,
      target: TARGET,
      amount: 1_000_000n,
      nonce: 0n,
      chainId: ARC_CHAIN_ID,
    });
    // personal_sign over the raw 32 bytes == Solidity toEthSignedMessageHash(structHash)
    const signature = await signer.signMessage({ message: { raw: hash } });
    const recovered = await recoverMessageAddress({ message: { raw: hash }, signature });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it('sweepStructHash is distinct from payStructHash for the same account', () => {
    const pay = payStructHash({ account: ACCOUNT, target: TARGET, amount: 1n, nonce: 0n, chainId: ARC_CHAIN_ID });
    const sweep = sweepStructHash({ account: ACCOUNT, vault: TARGET, nonce: 0n, chainId: ARC_CHAIN_ID });
    expect(pay).not.toBe(sweep);
  });
});
