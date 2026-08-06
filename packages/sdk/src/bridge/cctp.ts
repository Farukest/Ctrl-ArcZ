import {
  encodeFunctionData,
  erc20Abi,
  pad,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

/**
 * Bridge USDC across chains with the sender's own funds.
 *
 * CCTP is burn-and-mint, which is precisely why it needs no liquidity provider:
 * the holder's USDC is destroyed on the source chain and Circle authorises an
 * equal mint on the destination. Nobody has to front anything.
 *
 * That property is easy to give away by accident. Route the burn through a relayer
 * key and it is the operator's USDC being destroyed, the operator funding every
 * user's transfer, and the operator briefly holding funds that are not theirs --
 * three problems the protocol had already solved. It also puts a ceiling on the
 * product: a transfer can never exceed what the operator happens to be holding.
 *
 * So the burn is signed by the wallet that owns the money, `mintRecipient` is that
 * same wallet on the destination, and no server key appears anywhere in this file.
 * The operator's remaining jobs -- relaying stealth deploys, paying gas for a
 * claim -- are gas, bounded and legitimate. Funding other people's transfers is not.
 *
 * Circle's Forwarding Service submits the destination mint, so the sender needs no
 * gas on the chain they are bridging to. The fee for it is quoted per transfer and
 * paid out of the burn, not by us.
 *
 * Sources, transcribed rather than recalled:
 *   - https://docs.arc.io/circle/cctp/references/contract-addresses
 *   - https://docs.arc.io/circle/cctp/quickstarts/transfer-usdc-ethereum-to-arc
 */

/** CCTP v2 TokenMessenger. One address on every testnet; Circle deploys with CREATE2. */
export const CCTP_TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;

/** Circle's testnet attestation service. */
export const IRIS_TESTNET = 'https://iris-api-sandbox.circle.com' as const;

/**
 * Tells Circle to submit the destination mint itself. Verified against the
 * quickstart; it is `ctp-forward` in ASCII, right-padded to 32 bytes.
 */
export const FORWARDING_HOOK =
  '0x636374702d666f72776172640000000000000000000000000000000000000000' as const;

/**
 * Fast transfer. The fee endpoint quotes per finality threshold and 1000 is the
 * fast tier the forwarding service serves; anything slower is quoted separately.
 */
const FAST_FINALITY = 1000;

/**
 * Anyone may submit the mint. Naming a caller here would mean only that address
 * could complete the transfer, which is exactly the dependency this design avoids.
 */
const ANY_CALLER = `0x${'00'.repeat(32)}` as Hex;

/** Chains this can bridge between, with the two facts the burn needs. */
export interface CctpChain {
  /** CCTP domain id. Not a chain id. */
  domain: number;
  /** USDC on that chain. Verified on chain, not transcribed from memory. */
  usdc: Address;
}

export const CCTP_CHAINS = {
  Arc_Testnet: { domain: 26, usdc: '0x3600000000000000000000000000000000000000' },
  Ethereum_Sepolia: { domain: 0, usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  Base_Sepolia: { domain: 6, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
} as const satisfies Record<string, CctpChain>;

export type CctpChainName = keyof typeof CCTP_CHAINS;

const tokenMessengerAbi = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export interface BridgeQuote {
  /** What arrives on the destination, in USDC subunits. */
  amount: bigint;
  /** Circle's protocol fee plus the forwarding fee. Comes out of the burn. */
  maxFee: bigint;
  /** What leaves the sender's wallet: amount + maxFee. */
  total: bigint;
}

/**
 * What this transfer will cost, quoted immediately before it is sent.
 *
 * The forwarding fee is dynamic. Quoting it earlier and reusing the number is how a
 * burn ends up with a `maxFee` too small for Circle to accept, which strands the
 * transfer at exactly the step that cannot be undone.
 */
export async function quoteBridge(params: {
  from: CctpChainName;
  to: CctpChainName;
  /** USDC subunits to deliver. */
  amount: bigint;
  fetchImpl?: typeof fetch;
}): Promise<BridgeQuote> {
  const src = CCTP_CHAINS[params.from];
  const dst = CCTP_CHAINS[params.to];
  const doFetch = params.fetchImpl ?? fetch;
  const res = await doFetch(
    `${IRIS_TESTNET}/v2/burn/USDC/fees/${src.domain}/${dst.domain}?forward=true`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
  );
  if (!res.ok) throw new Error(`Could not price this transfer (${res.status}).`);
  const fees = (await res.json()) as {
    finalityThreshold: number;
    forwardFee?: { med?: string };
    minimumFee: number;
  }[];
  const fast = fees.find((f) => f.finalityThreshold === FAST_FINALITY);
  if (!fast?.forwardFee?.med) {
    throw new Error('Circle is not quoting a fast forwarded transfer on this route.');
  }
  const forwardFee = BigInt(fast.forwardFee.med);
  // minimumFee is in basis points of a basis point (1e-6), per the quickstart.
  const protocolFee = (params.amount * BigInt(Math.round(fast.minimumFee * 100))) / 1_000_000n;
  const maxFee = forwardFee + protocolFee;
  return { amount: params.amount, maxFee, total: params.amount + maxFee };
}

export type CctpStep = 'quote' | 'approve' | 'burn' | 'forward';

export interface BridgeResult {
  approveTxHash?: Hex;
  burnTxHash: Hex;
  /** The destination mint, submitted by Circle. */
  forwardTxHash?: Hex;
  quote: BridgeQuote;
}

/**
 * Burn on the source chain and let Circle mint on the destination.
 *
 * `clients.walletClient` must be connected to `from`; the money being burned is
 * whatever that wallet holds. Nothing here can move funds belonging to anyone else,
 * which is the point.
 */
export async function bridgeFromWallet(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  params: {
    from: CctpChainName;
    to: CctpChainName;
    amount: bigint;
    /**
     * Where the USDC lands. Defaults to the sending wallet, which is what a bridge
     * means; pass another address only when you deliberately intend to pay someone.
     */
    recipient?: Address;
    onStep?: (step: CctpStep, txHash?: Hex) => void;
    /**
     * How long to wait for Circle's forwarded mint before returning. Returning
     * early is safe: the burn has happened and the attestation is permanent, so a
     * caller who wants to stop watching loses nothing but the wait.
     */
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<BridgeResult> {
  if (params.from === params.to) throw new Error('Source and destination must differ.');
  if (params.amount <= 0n) throw new Error('Amount must be positive.');
  const account = clients.walletClient.account;
  if (!account) throw new Error('No wallet account to bridge from.');

  const src = CCTP_CHAINS[params.from];
  const dst = CCTP_CHAINS[params.to];
  const recipient = params.recipient ?? account.address;

  params.onStep?.('quote');
  const quote = await quoteBridge({
    from: params.from,
    to: params.to,
    amount: params.amount,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });

  // Refuse before signing anything if the wallet cannot cover the burn. The chain
  // would refuse too, but only after the user has approved a transaction.
  const balance = (await clients.publicClient.readContract({
    address: src.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;
  if (balance < quote.total) {
    throw new Error(
      `This wallet holds ${Number(balance) / 1e6} USDC on ${params.from.replace(/_/g, ' ')} and the transfer needs ${Number(quote.total) / 1e6} including fees.`,
    );
  }

  // Approve exactly the total. An unbounded approval to a contract that can move
  // USDC is a standing risk for a one-off transfer.
  const allowance = (await clients.publicClient.readContract({
    address: src.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, CCTP_TOKEN_MESSENGER],
  })) as bigint;

  let approveTxHash: Hex | undefined;
  if (allowance < quote.total) {
    approveTxHash = await clients.walletClient.writeContract({
      address: src.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [CCTP_TOKEN_MESSENGER, quote.total],
      account,
      chain: clients.walletClient.chain ?? null,
    });
    await clients.publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    params.onStep?.('approve', approveTxHash);
  } else {
    params.onStep?.('approve');
  }

  const burnTxHash = await clients.walletClient.sendTransaction({
    to: CCTP_TOKEN_MESSENGER,
    data: encodeFunctionData({
      abi: tokenMessengerAbi,
      functionName: 'depositForBurnWithHook',
      args: [
        quote.total,
        dst.domain,
        pad(recipient, { size: 32 }),
        src.usdc,
        ANY_CALLER,
        quote.maxFee,
        FAST_FINALITY,
        FORWARDING_HOOK,
      ],
    }),
    account,
    chain: clients.walletClient.chain ?? null,
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: burnTxHash });
  params.onStep?.('burn', burnTxHash);

  const forwardTxHash = await waitForForwardedMint({
    sourceDomain: src.domain,
    burnTxHash,
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  if (forwardTxHash) params.onStep?.('forward', forwardTxHash);

  return {
    ...(approveTxHash ? { approveTxHash } : {}),
    burnTxHash,
    ...(forwardTxHash ? { forwardTxHash } : {}),
    quote,
  };
}

/**
 * Poll Circle until it reports the destination mint it submitted.
 *
 * Returns undefined on timeout rather than throwing, and the distinction matters:
 * the burn has already happened, the attestation is permanent, and Circle will
 * still forward it. A timeout here means "not yet", never "lost". The burn hash is
 * the receipt, which is why it is returned regardless.
 */
export async function waitForForwardedMint(params: {
  sourceDomain: number;
  burnTxHash: Hex;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<Hex | undefined> {
  const doFetch = params.fetchImpl ?? fetch;
  const deadline = Date.now() + (params.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    try {
      const res = await doFetch(
        `${IRIS_TESTNET}/v2/messages/${params.sourceDomain}?transactionHash=${params.burnTxHash}`,
      );
      if (res.ok) {
        const body = (await res.json()) as { messages?: { forwardTxHash?: string }[] };
        const hash = body.messages?.find((m) => m.forwardTxHash)?.forwardTxHash;
        if (hash) return hash as Hex;
      }
    } catch {
      // A failed poll is not a failed transfer. Try again until the deadline.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return undefined;
}
