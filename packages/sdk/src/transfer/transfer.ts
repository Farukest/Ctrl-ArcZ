import {
  encodeFunctionData,
  erc20Abi,
  isAddress,
  parseEventLogs,
  stringToHex,
  zeroAddress,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { ctrlArcZAbi, memoAbi } from '../abi/ctrlArcZ.js';
import { ADDRESSES, CTRL_ARCZ_ADDRESS } from '../chains/arcTestnet.js';
import {
  ClaimOutcomeUnknownError,
  TransferLockedError,
  TransferUnavailableError,
  WrongClaimCodeError,
  decodeRevert,
} from './errors.js';

/** Maps a contract revert to a clean typed error; rethrows anything unrecognized. */
function mapTransferRevert(err: unknown, allowNotSender = false): never {
  const name = decodeRevert(err)?.name;
  if (name === 'TransferNotPending') throw new TransferUnavailableError('not_pending');
  if (name === 'TransferExpired') throw new TransferUnavailableError('expired');
  if (name === 'UnknownTransfer') throw new TransferUnavailableError('unknown');
  if (name === 'NotSender' && allowNotSender) throw new TransferUnavailableError('not_sender');
  throw err;
}
import { signPermit2Transfer } from './permit2.js';

/**
 * Defensive guard for the send path. The risk `check()` is the real poisoning
 * defense and is caller-invoked, but a zero/invalid recipient or a non-positive
 * amount should never reach the contract regardless.
 */
function assertSendParams(params: { to: Address; amount: bigint }): void {
  if (!isAddress(params.to) || params.to === zeroAddress) {
    throw new Error(`Invalid recipient address: ${params.to}`);
  }
  if (params.amount <= 0n) {
    throw new Error('Transfer amount must be greater than zero');
  }
}

export interface ClientPair {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Overrides the deployed CtrlArcZ address (tests, alternative deployments). */
  contractAddress?: Address;
}

export type TransferStatus = 'NONE' | 'PENDING' | 'CLAIMED' | 'CANCELLED' | 'RECLAIMED' | 'LOCKED';

const STATUS: readonly TransferStatus[] = [
  'NONE',
  'PENDING',
  'CLAIMED',
  'CANCELLED',
  'RECLAIMED',
  'LOCKED',
] as const;

export interface ProtectedTransfer {
  transferId: bigint;
  sender: Address;
  to: Address;
  amount: bigint;
  deadline: Date;
  attempts: number;
  status: TransferStatus;
  claimHash: Hex;
  configId: Hex;
}

export interface SendProtectedParams {
  configId: Hex;
  to: Address;
  /** Base units — 6 decimals on Arc's USDC ERC-20 interface. */
  amount: bigint;
  claimHash: Hex;
  /**
   * Wrap the call in Arc's Memo predeploy so the transfer is reconcilable from
   * `Memo` events. Default true. `memoId` is set to `claimHash`, which is known
   * before the call, unlike `transferId`.
   */
  memo?: boolean;
}

export interface SendProtectedResult {
  transferId: bigint;
  txHash: Hash;
  deadline: Date;
}

const contractOf = (clients: ClientPair): Address =>
  clients.contractAddress ?? (CTRL_ARCZ_ADDRESS as Address);

/**
 * Returns the wallet's account. Passing the account OBJECT (not just its address)
 * to writeContract is what tells viem to sign locally and submit via
 * `eth_sendRawTransaction`. A bare address string is treated as a JSON-RPC account
 * and viem calls `wallet_sendTransaction`, which Arc's RPC does not support.
 */
function requireAccount(walletClient: WalletClient): Account | Address {
  const account = walletClient.account;
  if (!account) throw new Error('walletClient has no account');
  return account;
}

/** Current USDC allowance granted to CtrlArcZ. */
export async function getAllowance(clients: ClientPair, owner: Address): Promise<bigint> {
  return clients.publicClient.readContract({
    address: ADDRESSES.USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, contractOf(clients)],
  });
}

const addressOf = (account: Account | Address): Address =>
  typeof account === 'string' ? account : account.address;

/** Approve CtrlArcZ to pull `amount` USDC. Returns null when the allowance already covers it. */
export async function approveUsdc(clients: ClientPair, amount: bigint): Promise<Hash | null> {
  const account = requireAccount(clients.walletClient);
  const allowance = await getAllowance(clients, addressOf(account));
  if (allowance >= amount) return null;

  const hash = await clients.walletClient.writeContract({
    address: ADDRESSES.USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [contractOf(clients), amount],
    account,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Locks the funds. Requires a prior `approveUsdc`.
 *
 * The call is wrapped in Arc's `Memo` predeploy by default. Memo only accepts a
 * direct EOA caller — a contract calling it reverts as sender spoofing — so the
 * wrapping happens here, not inside CtrlArcZ. The CallFrom precompile preserves
 * the user's address as `msg.sender` inside `sendProtected`, so `cancel` rights
 * still belong to the human.
 */
export async function sendProtected(
  clients: ClientPair,
  params: SendProtectedParams,
): Promise<SendProtectedResult> {
  const account = requireAccount(clients.walletClient);
  assertSendParams(params);
  const contract = contractOf(clients);
  const useMemo = params.memo ?? true;

  const data = encodeFunctionData({
    abi: ctrlArcZAbi,
    functionName: 'sendProtected',
    args: [params.configId, params.to, params.amount, params.claimHash],
  });

  const hash = useMemo
    ? await clients.walletClient.writeContract({
        address: ADDRESSES.MEMO,
        abi: memoAbi,
        functionName: 'memo',
        args: [contract, data, params.claimHash, stringToHex('ctrl-arcz:v1:protected-transfer')],
        account,
        chain: clients.walletClient.chain ?? null,
      })
    : await clients.walletClient.sendTransaction({
        to: contract,
        data,
        account,
        chain: clients.walletClient.chain ?? null,
      });

  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`sendProtected reverted: ${hash}`);
  }

  const events = parseEventLogs({
    abi: ctrlArcZAbi,
    eventName: 'TransferCreated',
    logs: receipt.logs,
  }).filter((e) => e.address.toLowerCase() === contract.toLowerCase());
  const created = events[0];
  if (!created) {
    throw new Error(`TransferCreated not found in receipt ${hash}`);
  }

  return {
    transferId: created.args.transferId,
    txHash: hash,
    deadline: new Date(Number(created.args.deadline) * 1000),
  };
}

/**
 * Like `sendProtected`, but pulls USDC via a Permit2 signature — no per-send
 * `approve` transaction. The one-time prerequisite is `approvePermit2(clients)`.
 *
 * The whole thing is a single on-chain transaction (the signature is off-chain
 * and free). Not wrapped in Memo: routing through Memo would make CtrlArcZ the
 * `msg.sender` Permit2 sees, breaking the spender check; a plain direct call
 * keeps the user as both the permit signer and the Permit2 caller's authoriser.
 */
export async function sendProtectedWithPermit(
  clients: ClientPair,
  params: SendProtectedParams,
): Promise<SendProtectedResult> {
  const account = requireAccount(clients.walletClient);
  assertSendParams(params);
  const contract = contractOf(clients);

  const permit = await signPermit2Transfer(clients, params.amount, contract);

  const hash = await clients.walletClient.writeContract({
    address: contract,
    abi: ctrlArcZAbi,
    functionName: 'sendProtectedWithPermit',
    args: [
      params.configId,
      params.to,
      params.amount,
      params.claimHash,
      permit.nonce,
      permit.deadline,
      permit.signature,
    ],
    account,
    chain: clients.walletClient.chain ?? null,
  });

  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`sendProtectedWithPermit reverted: ${hash}`);
  }

  const events = parseEventLogs({
    abi: ctrlArcZAbi,
    eventName: 'TransferCreated',
    logs: receipt.logs,
  }).filter((e) => e.address.toLowerCase() === contract.toLowerCase());
  const created = events[0];
  if (!created) {
    throw new Error(`TransferCreated not found in receipt ${hash}`);
  }

  return {
    transferId: created.args.transferId,
    txHash: hash,
    deadline: new Date(Number(created.args.deadline) * 1000),
  };
}

/**
 * Releases a transfer to its recipient.
 *
 * A wrong code does NOT revert on-chain (the attempt counter has to survive, or
 * the 5-guess lockout could never bind), so a mined transaction is not proof of
 * success. The receipt is inspected and a failure is raised as an exception.
 */
/** ABI-encoded calldata for `claim(transferId, code, salt)` — for gasless / ERC-4337 flows. */
export function encodeClaimCall(transferId: bigint, code: string, salt: Hex): Hex {
  return encodeFunctionData({
    abi: ctrlArcZAbi,
    functionName: 'claim',
    args: [transferId, code, salt],
  });
}

/**
 * Turns a mined claim transaction's logs into the outcome. A wrong code does NOT
 * revert (the attempt counter must persist), so success is proven by events, not
 * the tx status. Returns the tx hash on success; throws a typed error otherwise.
 * Shared by the direct EOA `claim` and any gasless (bundler/userOp) claim path, so
 * both report identical typed outcomes.
 */
export function interpretClaimReceipt(
  receiptLogs: Log[],
  contractAddress: Address,
  transferId: bigint,
  txHash: Hash,
): Hash {
  // Bind to BOTH the emitting contract and this exact transferId. A receipt can
  // carry logs from other contracts and, in a batched/ERC-4337 flow, from other
  // transfers or userOps in the same transaction; matching by event name alone
  // would let an unrelated (or attacker-planted) event decide this outcome.
  const fromContract = (log: { address: Address }) =>
    log.address.toLowerCase() === contractAddress.toLowerCase();
  const matchesId = (log: { args: Record<string, unknown> }) =>
    'transferId' in log.args && log.args.transferId === transferId;
  const logs = parseEventLogs({ abi: ctrlArcZAbi, logs: receiptLogs }).filter(
    (log) => fromContract(log) && matchesId(log),
  );

  if (logs.some((log) => log.eventName === 'TransferClaimed')) return txHash;
  if (logs.some((log) => log.eventName === 'TransferLocked')) {
    throw new TransferLockedError(transferId, txHash);
  }
  const failed = logs.find((log) => log.eventName === 'ClaimAttemptFailed');
  if (failed && 'attempts' in failed.args) {
    const attempts = Number(failed.args.attempts);
    throw new WrongClaimCodeError(transferId, Math.max(0, 5 - attempts), txHash);
  }
  throw new ClaimOutcomeUnknownError(txHash);
}

export async function claim(
  clients: ClientPair,
  transferId: bigint,
  code: string,
  salt: Hex,
): Promise<Hash> {
  const account = requireAccount(clients.walletClient);

  let hash: Hash;
  try {
    hash = await clients.walletClient.writeContract({
      address: contractOf(clients),
      abi: ctrlArcZAbi,
      functionName: 'claim',
      args: [transferId, code, salt],
      account,
      chain: clients.walletClient.chain ?? null,
    });
  } catch (e) {
    mapTransferRevert(e);
  }

  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new TransferUnavailableError('not_pending');
  return interpretClaimReceipt(receipt.logs, contractOf(clients), transferId, hash);
}

/** Take the money back. Sender only, allowed until a claim lands. */
export async function cancel(clients: ClientPair, transferId: bigint): Promise<Hash> {
  const account = requireAccount(clients.walletClient);

  let hash: Hash;
  try {
    hash = await clients.walletClient.writeContract({
      address: contractOf(clients),
      abi: ctrlArcZAbi,
      functionName: 'cancel',
      args: [transferId],
      account,
      chain: clients.walletClient.chain ?? null,
    });
  } catch (e) {
    mapTransferRevert(e, true);
  }

  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new TransferUnavailableError('not_pending');
  return hash;
}

/** Refund an expired, unclaimed transfer. Anyone may call; the money goes to the sender. */
export async function reclaimExpired(clients: ClientPair, transferId: bigint): Promise<Hash> {
  const account = requireAccount(clients.walletClient);

  let hash: Hash;
  try {
    hash = await clients.walletClient.writeContract({
      address: contractOf(clients),
      abi: ctrlArcZAbi,
      functionName: 'reclaimExpired',
      args: [transferId],
      account,
      chain: clients.walletClient.chain ?? null,
    });
  } catch (e) {
    mapTransferRevert(e);
  }

  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new TransferUnavailableError('not_pending');
  return hash;
}

export async function getTransfer(
  clients: Pick<ClientPair, 'publicClient' | 'contractAddress'>,
  transferId: bigint,
): Promise<ProtectedTransfer> {
  const raw = await clients.publicClient.readContract({
    address: clients.contractAddress ?? (CTRL_ARCZ_ADDRESS as Address),
    abi: ctrlArcZAbi,
    functionName: 'getTransfer',
    args: [transferId],
  });

  return {
    transferId,
    sender: raw.sender,
    to: raw.to,
    amount: raw.amount,
    deadline: new Date(Number(raw.deadline) * 1000),
    attempts: raw.attempts,
    status: STATUS[raw.status] ?? 'NONE',
    claimHash: raw.claimHash,
    configId: raw.configId,
  };
}

export interface WatchTransferOptions {
  /** Called on every state change of the watched transfer. */
  onUpdate: (transfer: ProtectedTransfer) => void;
  contractAddress?: Address;
}

/**
 * Follows a transfer until it settles. Returns an unsubscribe function.
 *
 * Arc finalises on inclusion, so a single confirmation is final: the callback
 * fires as soon as the event lands, with no "confirming" limbo.
 */
export function watchTransfer(
  publicClient: PublicClient,
  transferId: bigint,
  options: WatchTransferOptions,
): () => void {
  const address = options.contractAddress ?? (CTRL_ARCZ_ADDRESS as Address);

  const unwatch = publicClient.watchContractEvent({
    address,
    abi: ctrlArcZAbi,
    onLogs: async (logs) => {
      const touched = logs.some(
        (log) =>
          'args' in log &&
          log.args !== null &&
          typeof log.args === 'object' &&
          'transferId' in log.args &&
          (log.args as { transferId?: bigint }).transferId === transferId,
      );
      if (!touched) return;

      const transfer = await getTransfer({ publicClient, contractAddress: address }, transferId);
      options.onUpdate(transfer);
    },
  });

  return unwatch;
}
