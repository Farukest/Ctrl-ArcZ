import { erc20Abi, pad, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { CCTP_CHAINS, chainLabel, type CctpChainName } from './cctp.js';

/**
 * Circle Gateway with the sender's own funds.
 *
 * Gateway is not a bridge you push money through; it is a balance you keep. USDC
 * deposited into the GatewayWallet contract on any supported chain is still yours,
 * credited to your address, and Circle counts the deposits across every chain as one
 * unified balance. Spending it needs no source-chain transaction at all: a signed
 * intent, and the money appears on whichever chain you named.
 *
 * That is what makes it worth having next to CCTP. CCTP asks you to choose the
 * destination and then wait, every single time. Gateway asks you to wait once, and
 * every spend after that is immediate, to any chain, split however you like.
 *
 * It was previously driven server-side through Circle's Unified Balance Kit, which
 * is Node-first. Nobody decided the operator should fund it; it followed from where
 * the code ran, because the only key on a server is the operator's. So the deposit
 * was the relayer's, the unified balance was the relayer's, and every user was
 * spending the operator's money. Nothing here needs a server: the deposit is an
 * ordinary contract call, the spend is an EIP-712 signature, and Circle's transfer
 * endpoint takes no API key because the signature over the intent is the authority.
 *
 * Sources, transcribed and then measured:
 *   - docs-arc/circle/gateway/quickstarts/unified-balance-evm.md
 *   - docs-arc/circle/gateway/references/supported-blockchains.md
 */

/** GatewayWallet: holds deposits. One address on every chain. Verified to have code. */
export const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const;

/** GatewayMinter: mints on the destination. Also one address everywhere. */
export const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as const;

export const GATEWAY_API_TESTNET = 'https://gateway-api-testnet.circle.com' as const;

/**
 * Chains Gateway serves that also have a USDC address this SDK has verified.
 *
 * Circle lists one more EVM testnet for Gateway, HyperEVM (domain 19), and it is
 * absent for the same reason EDGE and Pharos are absent from `CCTP_CHAINS`: no
 * published USDC address to check, so nothing to be confident about. Solana is out
 * of scope here because this module signs with an EVM wallet.
 *
 * The domain, chain id and USDC address all come from `CCTP_CHAINS`, which is the
 * table that was read off each chain. Restating them here would be a second place to
 * get them wrong.
 */
export const GATEWAY_CHAIN_NAMES = [
  'Arc_Testnet',
  'Ethereum_Sepolia',
  'Avalanche_Fuji',
  'OP_Sepolia',
  'Arbitrum_Sepolia',
  'Base_Sepolia',
  'Polygon_Amoy',
  'Unichain_Sepolia',
  'Sonic_Testnet',
  'World_Chain_Sepolia',
  'Sei_Testnet',
] as const satisfies readonly CctpChainName[];

export type GatewayChain = (typeof GATEWAY_CHAIN_NAMES)[number];

export function isGatewayChain(name: string): name is GatewayChain {
  return (GATEWAY_CHAIN_NAMES as readonly string[]).includes(name);
}

/**
 * How long a deposit takes to count, per Circle's published block confirmations.
 *
 * This is the whole cost of using Gateway, and it is wildly uneven: depositing on
 * Arc is half a second, depositing on Base is up to nineteen minutes. A caller that
 * shows one number for all of them is lying about ten of the eleven, which is why
 * this is exposed rather than averaged away.
 */
export const DEPOSIT_CONFIRMATION_SECONDS: Record<GatewayChain, number> = {
  Arc_Testnet: 1,
  Avalanche_Fuji: 8,
  Polygon_Amoy: 8,
  Sonic_Testnet: 8,
  Sei_Testnet: 5,
  Ethereum_Sepolia: 19 * 60,
  Base_Sepolia: 19 * 60,
  OP_Sepolia: 19 * 60,
  Arbitrum_Sepolia: 19 * 60,
  Unichain_Sepolia: 19 * 60,
  World_Chain_Sepolia: 19 * 60,
};

const gatewayWalletAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** The EIP-712 domain is chain-agnostic: no chainId, no verifyingContract. */
const EIP712_DOMAIN = { name: 'GatewayWallet', version: '1' } as const;

const TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
  ],
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
} as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/** bigint values have to reach Circle as decimal strings, not JSON numbers. */
function jsonBigints(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export interface GatewayBalance {
  /** Spendable now, across every chain, in USDC subunits. */
  total: bigint;
  /** Per chain, so a caller can say where the money actually sits. */
  byChain: Partial<Record<GatewayChain, bigint>>;
}

/**
 * What this address can spend through Gateway right now.
 *
 * Only counts deposits that have reached the confirmations Circle requires; a
 * deposit made seconds ago on a slow chain simply is not here yet. That is the
 * honest reading, and reporting a pending deposit as spendable would produce an
 * intent the API rejects.
 */
export async function gatewayBalance(params: {
  depositor: Address;
  chains?: readonly GatewayChain[];
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<GatewayBalance> {
  const chains = params.chains ?? GATEWAY_CHAIN_NAMES;
  const doFetch = params.fetchImpl ?? fetch;
  const res = await doFetch(`${params.apiBase ?? GATEWAY_API_TESTNET}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: chains.map((c) => ({ domain: CCTP_CHAINS[c].domain, depositor: params.depositor })),
    }),
  });
  if (!res.ok) throw new Error(`Could not read the Gateway balance (${res.status}).`);
  const body = (await res.json()) as { balances?: { domain: number; balance: string }[] };

  const byChain: Partial<Record<GatewayChain, bigint>> = {};
  let total = 0n;
  for (const entry of body.balances ?? []) {
    const name = chains.find((c) => CCTP_CHAINS[c].domain === entry.domain);
    if (!name) continue;
    // The API reports a decimal figure ("1.500000"), not subunits.
    const subunits = BigInt(Math.round(Number(entry.balance) * 1e6));
    byChain[name] = subunits;
    total += subunits;
  }
  return { total, byChain };
}

export type GatewayStep = 'approve' | 'deposit' | 'quote' | 'sign' | 'transfer' | 'mint';

/**
 * Move USDC from the wallet into its Gateway balance on one chain.
 *
 * A plain ERC-20 transfer to the contract does not work and does not fail loudly
 * either; the deposit method has to be called, or the USDC is simply sitting at an
 * address that will not credit it.
 *
 * The money is not spent or locked away. It is the same USDC, held somewhere it can
 * be moved from without a source-chain transaction, and a same-chain transfer takes
 * it back with no transfer fee.
 */
export async function depositToGateway(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  params: {
    chain: GatewayChain;
    /** USDC subunits. */
    amount: bigint;
    onStep?: (step: GatewayStep, txHash?: Hex) => void;
  },
): Promise<{ approveTxHash?: Hex; depositTxHash: Hex }> {
  if (params.amount <= 0n) throw new Error('Deposit must be positive.');
  const account = clients.walletClient.account;
  if (!account) throw new Error('No wallet account to deposit from.');

  const chain = CCTP_CHAINS[params.chain];
  const connected = clients.walletClient.chain?.id;
  if (connected != null && connected !== chain.chainId) {
    throw new Error(
      `This wallet is on chain ${connected}. Switch it to ${chainLabel(params.chain)} (chain ${chain.chainId}) to deposit there.`,
    );
  }

  const balance = (await clients.publicClient.readContract({
    address: chain.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;
  if (balance < params.amount) {
    throw new Error(
      `This wallet holds ${Number(balance) / 1e6} USDC on ${chainLabel(params.chain)} and the deposit is ${Number(params.amount) / 1e6}.`,
    );
  }

  const allowance = (await clients.publicClient.readContract({
    address: chain.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, GATEWAY_WALLET],
  })) as bigint;

  let approveTxHash: Hex | undefined;
  if (allowance < params.amount) {
    approveTxHash = await clients.walletClient.writeContract({
      address: chain.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [GATEWAY_WALLET, params.amount],
      account,
      chain: clients.walletClient.chain ?? null,
    });
    await clients.publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    params.onStep?.('approve', approveTxHash);
  } else {
    params.onStep?.('approve');
  }

  const depositTxHash = await clients.walletClient.writeContract({
    address: GATEWAY_WALLET,
    abi: gatewayWalletAbi,
    functionName: 'deposit',
    args: [chain.usdc, params.amount],
    account,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: depositTxHash });
  params.onStep?.('deposit', depositTxHash);

  return { ...(approveTxHash ? { approveTxHash } : {}), depositTxHash };
}

function buildSpec(params: {
  from: GatewayChain;
  to: GatewayChain;
  depositor: Address;
  recipient: Address;
  amount: bigint;
  salt: Hex;
}) {
  const src = CCTP_CHAINS[params.from];
  const dst = CCTP_CHAINS[params.to];
  return {
    version: 1,
    sourceDomain: src.domain,
    destinationDomain: dst.domain,
    sourceContract: pad(GATEWAY_WALLET, { size: 32 }),
    destinationContract: pad(GATEWAY_MINTER, { size: 32 }),
    sourceToken: pad(src.usdc, { size: 32 }),
    destinationToken: pad(dst.usdc, { size: 32 }),
    sourceDepositor: pad(params.depositor, { size: 32 }),
    destinationRecipient: pad(params.recipient, { size: 32 }),
    sourceSigner: pad(params.depositor, { size: 32 }),
    // Anyone may submit the mint. Naming a caller would make the transfer depend on
    // that one address showing up.
    destinationCaller: pad(ZERO_ADDRESS, { size: 32 }),
    value: params.amount,
    salt: params.salt,
    hookData: '0x' as Hex,
  };
}

export interface GatewayQuote {
  /** What Circle will take, in USDC subunits. Flat: it does not scale with amount. */
  maxFee: bigint;
  maxBlockHeight: bigint;
  /** amount + maxFee, which is what the Gateway balance has to cover. */
  total: bigint;
}

/**
 * Price the spend before signing it.
 *
 * Measured against Circle's testnet endpoint rather than assumed: the fee came back
 * identical for 1, 5 and 200 USDC. It is a flat charge for the burn and the
 * forwarded mint, not a percentage, so a large transfer costs the same as a small
 * one and the balance needs only the amount plus a few cents.
 */
export async function quoteGatewaySpend(params: {
  from: GatewayChain;
  to: GatewayChain;
  amount: bigint;
  depositor: Address;
  recipient?: Address;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<GatewayQuote> {
  const doFetch = params.fetchImpl ?? fetch;
  const spec = buildSpec({
    from: params.from,
    to: params.to,
    depositor: params.depositor,
    recipient: params.recipient ?? params.depositor,
    amount: params.amount,
    salt: pad('0x01', { size: 32 }),
  });
  const res = await doFetch(
    `${params.apiBase ?? GATEWAY_API_TESTNET}/v1/estimate?enableForwarder=true`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBigints([{ spec }]),
    },
  );
  if (!res.ok) throw new Error(`Could not price this transfer (${res.status}).`);
  const body = (await res.json()) as {
    body?: { burnIntent?: { maxFee: string; maxBlockHeight: string } }[];
  };
  const estimate = body.body?.[0]?.burnIntent;
  if (!estimate) throw new Error('Circle did not quote this Gateway route.');
  const maxFee = BigInt(estimate.maxFee);
  return { maxFee, maxBlockHeight: BigInt(estimate.maxBlockHeight), total: params.amount + maxFee };
}

export interface GatewaySpendResult {
  transferId: string;
  /** The destination mint, once Circle's forwarder has submitted it. */
  mintTxHash?: Hex;
  quote: GatewayQuote;
}

/**
 * Spend from the Gateway balance. No source-chain transaction, no gas, no server.
 *
 * The wallet signs an intent and Circle mints on the destination. This is the part
 * that makes the deposit worth having: once the balance is confirmed, every spend is
 * a signature, and the same balance can go to any supported chain in any split.
 */
export async function spendFromGateway(
  clients: { walletClient: WalletClient },
  params: {
    from: GatewayChain;
    to: GatewayChain;
    amount: bigint;
    recipient?: Address;
    onStep?: (step: GatewayStep, txHash?: Hex) => void;
    /**
     * Fired the instant Circle accepts the intent, before the wait for the mint.
     *
     * This id is the receipt, and the wait is where a client gets closed. Handing it
     * back only with the finished result would mean an interrupted spend leaves
     * nothing to ask about, which is exactly the hole that had to be closed for CCTP
     * burns. A caller should persist it here, not at the end.
     */
    onTransferId?: (transferId: string) => void;
    /** How long to watch for the forwarded mint. Returning early loses nothing. */
    timeoutMs?: number;
    apiBase?: string;
    fetchImpl?: typeof fetch;
    /** Injectable so the salt can be pinned in tests; random otherwise. */
    salt?: Hex;
  },
): Promise<GatewaySpendResult> {
  if (params.from === params.to) throw new Error('Source and destination must differ.');
  if (params.amount <= 0n) throw new Error('Amount must be positive.');
  const account = clients.walletClient.account;
  if (!account) throw new Error('No wallet account to spend from.');

  const apiBase = params.apiBase ?? GATEWAY_API_TESTNET;
  const doFetch = params.fetchImpl ?? fetch;
  const recipient = params.recipient ?? account.address;

  params.onStep?.('quote');
  const quote = await quoteGatewaySpend({
    from: params.from,
    to: params.to,
    amount: params.amount,
    depositor: account.address,
    recipient,
    apiBase,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });

  // Refuse before signing when the balance cannot cover it. The API would refuse
  // too, but the point of checking here is to say which number is short and by how
  // much, and to name the deposit that would fix it.
  const balance = await gatewayBalance({
    depositor: account.address,
    apiBase,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  if (balance.total < quote.total) {
    throw new Error(
      `Your Gateway balance is ${Number(balance.total) / 1e6} USDC and this transfer needs ${Number(quote.total) / 1e6} including the ${Number(quote.maxFee) / 1e6} fee. Deposit into Gateway first.`,
    );
  }

  const spec = buildSpec({
    from: params.from,
    to: params.to,
    depositor: account.address,
    recipient,
    amount: params.amount,
    salt: params.salt ?? randomSalt(),
  });
  const message = { maxBlockHeight: quote.maxBlockHeight, maxFee: quote.maxFee, spec };

  // Cast wholesale: viem infers the message shape from `types`, and BurnIntent's
  // nested TransferSpec does not survive that inference. The shape is pinned by the
  // TYPES table above and asserted in the tests instead.
  const signature = await clients.walletClient.signTypedData({
    account,
    domain: EIP712_DOMAIN,
    types: TYPES,
    primaryType: 'BurnIntent',
    message,
  } as never);
  params.onStep?.('sign');

  const res = await doFetch(`${apiBase}/v1/transfer?enableForwarder=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonBigints([{ burnIntent: message, signature }]),
  });
  if (!res.ok) {
    throw new Error(`Gateway refused the transfer (${res.status}): ${await res.text()}`);
  }
  const { transferId } = (await res.json()) as { transferId?: string };
  if (!transferId) throw new Error('Gateway accepted the transfer but returned no id.');
  params.onTransferId?.(transferId);
  params.onStep?.('transfer');

  const mintTxHash = await waitForGatewayMint({
    transferId,
    apiBase,
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  if (mintTxHash) params.onStep?.('mint', mintTxHash);

  return { transferId, ...(mintTxHash ? { mintTxHash } : {}), quote };
}

/** A fresh salt per intent, so two identical transfers are two distinct intents. */
function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
}

export interface GatewayTransferStatus {
  /** `pending` covers every non-terminal state, including a poll that failed. */
  state: 'pending' | 'done' | 'failed';
  mintTxHash?: Hex;
  reason?: string;
}

/**
 * Watch Circle until the forwarded mint lands.
 *
 * Undefined on timeout means "not yet", not "lost": the intent is accepted and the
 * transferId can be asked about again at any time. A definite failure is different
 * and throws, because Gateway does report one. Reporting `failed` or `expired` as
 * "still working" would leave a caller polling forever for something that will never
 * arrive, which is the same mistake as calling a slow transfer a failed one, only
 * pointed the other way.
 */
export async function waitForGatewayMint(params: {
  transferId: string;
  timeoutMs?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<Hex | undefined> {
  const deadline = Date.now() + (params.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const status = await findGatewayMint(params);
    if (status.state === 'done') return status.mintTxHash;
    if (status.state === 'failed') {
      throw new Error(
        `Gateway could not complete transfer ${params.transferId}: ${status.reason ?? 'no reason given'}.`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

/**
 * One look. This is what recovers a spend the client stopped watching: the
 * transferId is enough, at any time, with no wallet and no signature.
 */
export async function findGatewayMint(params: {
  transferId: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<GatewayTransferStatus> {
  const doFetch = params.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `${params.apiBase ?? GATEWAY_API_TESTNET}/v1/transfer/${params.transferId}`,
    );
    if (!res.ok) return { state: 'pending' };
    const body = (await res.json()) as {
      status?: string;
      transactionHash?: string;
      forwardingDetails?: { failureReason?: string };
    };
    if (body.status === 'finalized' || body.status === 'confirmed') {
      return {
        state: 'done',
        ...(body.transactionHash ? { mintTxHash: body.transactionHash as Hex } : {}),
      };
    }
    if (body.status === 'failed' || body.status === 'expired') {
      return {
        state: 'failed',
        reason: body.forwardingDetails?.failureReason ?? body.status,
      };
    }
    return { state: 'pending' };
  } catch {
    // A failed poll is not a failed transfer.
    return { state: 'pending' };
  }
}
