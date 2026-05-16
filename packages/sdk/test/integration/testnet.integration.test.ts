/**
 * Integration tests against the real Arc Testnet: real USDC, real transactions.
 *
 * These are the tests that matter for Arc-specific behaviour. Foundry runs a stock
 * EVM and cannot reproduce Arc's native/ERC-20 dual balance model, its Memo
 * predeploy, or the CallFrom precompile (see https://docs.arc.io/arc/references/evm-differences),
 * so the only way to know the contract really works on Arc is to use it on Arc.
 *
 * Requires: a deployed CtrlArcZ (`pnpm deploy:testnet`) and funded SENDER/RECEIVER
 * keys in `.env`. Run with `pnpm --filter @ctrl-arcz/sdk test:integration`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseUnits,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, ADDRESSES, CTRL_ARCZ_ADDRESS, RPC_URL } from '../../src/chains/arcTestnet.js';
import {
  approveUsdc,
  cancel,
  claim,
  getTransfer,
  reclaimExpired,
  sendProtected,
  sendProtectedWithPermit,
  type ClientPair,
} from '../../src/transfer/transfer.js';
import { approvePermit2 } from '../../src/transfer/permit2.js';
import { generateClaimCode } from '../../src/transfer/claimCode.js';
import { defineConfig, registerConfig } from '../../src/config/config.js';
import { check } from '../../src/risk/check.js';
import { WrongClaimCodeError } from '../../src/transfer/errors.js';

const senderKey = process.env.SENDER_PRIVATE_KEY as `0x${string}` | undefined;
const receiverKey = process.env.RECEIVER_PRIVATE_KEY as `0x${string}` | undefined;
const contractAddress = (process.env.CTRL_ARCZ_ADDRESS ?? CTRL_ARCZ_ADDRESS) as Address;

const ready = Boolean(senderKey) && Boolean(receiverKey) && !/^0x0+$/.test(contractAddress);

const suite = ready ? describe : describe.skip;

/** Tiny, so the whole suite runs on a fraction of a USDC. */
const AMOUNT = parseUnits('0.02', 6);

suite('Arc Testnet — end to end', () => {
  let publicClient: PublicClient;
  let senderClients: ClientPair;
  let receiverClients: ClientPair;
  let senderAddress: Address;
  let receiverAddress: Address;
  let configId: `0x${string}`;
  /** A short window so the expiry test does not stall the suite. */
  let shortConfigId: `0x${string}`;

  const usdcBalance = (owner: Address) =>
    publicClient.readContract({
      address: ADDRESSES.USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    });

  beforeAll(async () => {
    const senderAccount = privateKeyToAccount(senderKey!);
    const receiverAccount = privateKeyToAccount(receiverKey!);
    senderAddress = senderAccount.address;
    receiverAddress = receiverAccount.address;

    publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

    const wallet = (account: typeof senderAccount): WalletClient =>
      createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) });

    senderClients = { publicClient, walletClient: wallet(senderAccount), contractAddress };
    receiverClients = { publicClient, walletClient: wallet(receiverAccount), contractAddress };

    ({ configId } = await registerConfig(senderClients, defineConfig({ recallWindow: 3600 })));
    ({ configId: shortConfigId } = await registerConfig(
      senderClients,
      defineConfig({ recallWindow: 1 }),
    ));

    await approveUsdc(senderClients, parseUnits('1000', 6));
  }, 120_000);

  it('USDC really is 6 decimals on the ERC-20 interface', async () => {
    const decimals = await publicClient.readContract({
      address: ADDRESSES.USDC,
      abi: erc20Abi,
      functionName: 'decimals',
    });
    expect(decimals).toBe(6);
  });

  /**
   * Flow 1 — the headline: send in one transaction, release with the code.
   * Also proves the contract can actually hold USDC on Arc, where an ERC-20
   * transfer moves the account's native balance.
   */
  it('send → claim: the recipient is paid in full and the contract ends up empty', async () => {
    const { code, salt, claimHash } = generateClaimCode();
    const recipientBefore = await usdcBalance(receiverAddress);
    const contractBefore = await usdcBalance(contractAddress);

    const sent = await sendProtected(senderClients, {
      configId,
      to: receiverAddress,
      amount: AMOUNT,
      claimHash,
    });
    console.log('send tx:', sent.txHash, 'transferId:', sent.transferId.toString());

    const locked = await getTransfer(senderClients, sent.transferId);
    expect(locked.status).toBe('PENDING');
    expect(locked.amount).toBe(AMOUNT);
    expect((await usdcBalance(contractAddress)) - contractBefore).toBe(AMOUNT);

    // Submitted by the SENDER as a relayer, so the RECEIVER pays no gas and the
    // balance change is exactly AMOUNT. On Arc gas is USDC, so a recipient who
    // claims their own transfer nets AMOUNT minus gas — the funds are still theirs,
    // the fee is just the network's. Relaying makes the accounting exact and proves
    // "anyone may submit; the money only ever goes to `to`".
    const claimTx = await claim(senderClients, sent.transferId, code, salt);
    console.log('claim tx:', claimTx);

    const settled = await getTransfer(senderClients, sent.transferId);
    expect(settled.status).toBe('CLAIMED');

    const recipientAfter = await usdcBalance(receiverAddress);
    expect(recipientAfter - recipientBefore).toBe(AMOUNT);
    expect(await usdcBalance(contractAddress)).toBe(contractBefore);
  }, 180_000);

  /** The recipient is now a proven counterparty, so the firewall says so. */
  it('a settled claim marks the recipient verified', async () => {
    const report = await check(senderAddress, receiverAddress, {
      client: publicClient,
      contractAddress,
    });
    expect(report.reasons.map((r) => r.code)).toContain('VERIFIED_RECIPIENT');
  }, 60_000);

  /** Flow 2 — the wrong-send undo. */
  it('send → cancel: the sender gets every unit back', async () => {
    const { claimHash } = generateClaimCode();
    const before = await usdcBalance(senderAddress);

    const sent = await sendProtected(senderClients, {
      configId,
      to: receiverAddress,
      amount: AMOUNT,
      claimHash,
    });
    const cancelTx = await cancel(senderClients, sent.transferId);
    console.log('cancel tx:', cancelTx);

    const after = await getTransfer(senderClients, sent.transferId);
    expect(after.status).toBe('CANCELLED');

    // Gas is paid in USDC on Arc, so the balance is "before minus gas", not "before".
    const balanceAfter = await usdcBalance(senderAddress);
    expect(balanceAfter).toBeGreaterThan(before - AMOUNT);
  }, 180_000);

  /** Flow 3 — nobody claims, the money comes home by itself. */
  it('send → wait → reclaimExpired: the refund needs no keeper', async () => {
    const { claimHash } = generateClaimCode();

    const sent = await sendProtected(senderClients, {
      configId: shortConfigId,
      to: receiverAddress,
      amount: AMOUNT,
      claimHash,
    });

    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Called by the RECEIVER: anyone may trigger it, the money still goes home.
    const reclaimTx = await reclaimExpired(receiverClients, sent.transferId);
    console.log('reclaim tx:', reclaimTx);

    const after = await getTransfer(senderClients, sent.transferId);
    expect(after.status).toBe('RECLAIMED');
  }, 180_000);

  /**
   * A wrong code must not release the funds — and, because the contract cannot
   * revert without losing the attempt counter, the SDK must be the thing that
   * turns that into an error.
   */
  it('a wrong code throws and burns exactly one attempt', async () => {
    const { salt, claimHash } = generateClaimCode();

    const sent = await sendProtected(senderClients, {
      configId,
      to: receiverAddress,
      amount: AMOUNT,
      claimHash,
    });

    await expect(claim(receiverClients, sent.transferId, '000000', salt)).rejects.toThrow(
      WrongClaimCodeError,
    );

    const after = await getTransfer(senderClients, sent.transferId);
    expect(after.attempts).toBe(1);
    expect(after.status).toBe('PENDING');

    await cancel(senderClients, sent.transferId);
  }, 180_000);

  /**
   * Gasless for the recipient — no paymaster, no Circle, no smart wallet needed.
   * A brand-new address that has never held USDC (so it could not pay Arc's
   * USDC gas) receives the funds, because `claim` is permissionless and always
   * pays the recorded recipient. A relayer (here the sender) submits and pays.
   * This is the "recipient needs no USDC" property, proven end to end.
   */
  it('gasless claim: a zero-USDC recipient is paid via a relayer', async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());

    // Precondition: the fresh account is truly empty and has never acted.
    const balanceBefore = await usdcBalance(fresh.address);
    const nonceBefore = await publicClient.getTransactionCount({ address: fresh.address });
    expect(balanceBefore).toBe(0n);
    expect(nonceBefore).toBe(0);

    const { code, salt, claimHash } = generateClaimCode();
    const sent = await sendProtected(senderClients, {
      configId,
      to: fresh.address,
      amount: AMOUNT,
      claimHash,
    });

    // The RELAYER (sender) submits and pays gas; the fresh recipient does nothing.
    const claimTx = await claim(senderClients, sent.transferId, code, salt);
    console.log('gasless claim tx (relayer-paid):', claimTx);

    const balanceAfter = await usdcBalance(fresh.address);
    const nonceAfter = await publicClient.getTransactionCount({ address: fresh.address });

    expect(balanceAfter).toBe(AMOUNT); // received in full
    expect(nonceAfter).toBe(0); // never sent a transaction → paid no gas
  }, 180_000);

  /**
   * Permit2 path against Arc's real Permit2 predeploy: a send with an off-chain
   * signature and no per-send approve. Exercised end to end, then claimed.
   */
  it('sendProtectedWithPermit: one-signature send via real Permit2, then claim', async () => {
    // One-time: the sender approves Permit2. After this, sends need only a signature.
    await approvePermit2(senderClients);

    const { code, salt, claimHash } = generateClaimCode();
    const recipientBefore = await usdcBalance(receiverAddress);

    const sent = await sendProtectedWithPermit(senderClients, {
      configId,
      to: receiverAddress,
      amount: AMOUNT,
      claimHash,
    });
    console.log('permit send tx:', sent.txHash, 'transferId:', sent.transferId.toString());

    const locked = await getTransfer(senderClients, sent.transferId);
    expect(locked.status).toBe('PENDING');
    expect(locked.amount).toBe(AMOUNT);
    expect(locked.sender.toLowerCase()).toBe(senderAddress.toLowerCase());

    // Settle via relayer for exact accounting.
    await claim(senderClients, sent.transferId, code, salt);
    const recipientAfter = await usdcBalance(receiverAddress);
    expect(recipientAfter - recipientBefore).toBe(AMOUNT);
  }, 180_000);
});
