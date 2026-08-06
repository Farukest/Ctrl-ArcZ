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
 * Tells Circle to submit the destination mint itself. It is the ASCII bytes of
 * `cctp-forward`, right-padded to 32 bytes; decoded and checked against the value
 * in Circle's quickstart rather than copied on faith.
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

/** Chains this can bridge between, with the three facts the burn needs. */
export interface CctpChain {
  /** CCTP domain id. Not a chain id; the two are unrelated numbers. */
  domain: number;
  /** EVM chain id, so a caller can check the wallet is on the right network first. */
  chainId: number;
  /** USDC on that chain. */
  usdc: Address;
}

/**
 * Every testnet Circle lists with both a CCTP domain and a USDC address.
 *
 * Domains come from `cctp/references/contract-addresses`, addresses from
 * `stablecoins/usdc-contract-addresses`. Neither was taken on faith: each row was
 * checked against its own chain, asserting `symbol() == USDC`, `decimals() == 6`,
 * the reported chain id, and that the TokenMessenger address actually has code
 * there. A wrong token address does not fail loudly -- it burns real money into a
 * contract that is not USDC.
 *
 * Two of Circle's listed testnets are absent, and the reason is stated rather than
 * quietly dropped: EDGE (domain 28) and Pharos (domain 31) have no public RPC that
 * answered, so their USDC addresses could not be verified. They can be added the
 * moment one does. Injective (29) is here because its EVM RPC did answer.
 *
 * Listing a chain is not a promise Circle will forward on that route -- `quoteBridge`
 * asks per transfer and refuses out loud when the answer is no.
 */
export const CCTP_CHAINS = {
  Arc_Testnet: { domain: 26, chainId: 5042002, usdc: '0x3600000000000000000000000000000000000000' },
  Ethereum_Sepolia: {
    domain: 0,
    chainId: 11155111,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  Avalanche_Fuji: { domain: 1, chainId: 43113, usdc: '0x5425890298aed601595a70AB815c96711a31Bc65' },
  OP_Sepolia: { domain: 2, chainId: 11155420, usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7' },
  Arbitrum_Sepolia: {
    domain: 3,
    chainId: 421614,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
  Base_Sepolia: { domain: 6, chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  Polygon_Amoy: { domain: 7, chainId: 80002, usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582' },
  Unichain_Sepolia: {
    domain: 10,
    chainId: 1301,
    usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F',
  },
  Linea_Sepolia: { domain: 11, chainId: 59141, usdc: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7' },
  Codex_Testnet: {
    domain: 12,
    chainId: 812242,
    usdc: '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f',
  },
  Sonic_Testnet: { domain: 13, chainId: 14601, usdc: '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51' },
  World_Chain_Sepolia: {
    domain: 14,
    chainId: 4801,
    usdc: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88',
  },
  Monad_Testnet: { domain: 15, chainId: 10143, usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3' },
  Sei_Testnet: { domain: 16, chainId: 1328, usdc: '0x4fCF1784B31630811181f670Aea7A7bEF803eaED' },
  XDC_Apothem: { domain: 18, chainId: 51, usdc: '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4' },
  Ink_Testnet: { domain: 21, chainId: 763373, usdc: '0xFabab97dCE620294D2B0b0e46C68964e326300Ac' },
  Plume_Testnet: { domain: 22, chainId: 98867, usdc: '0xcB5f30e335672893c7eb944B374c196392C19D18' },
  Injective_Testnet: {
    domain: 29,
    chainId: 1439,
    usdc: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d',
  },
  Morph_Hoodi: { domain: 30, chainId: 2910, usdc: '0x7433b41C6c5e1d58D4Da99483609520255ab661B' },
  Cronos_Testnet: { domain: 32, chainId: 338, usdc: '0xEb33dc5fac03833e132593659e1dE7256aB59794' },
} as const satisfies Record<string, CctpChain>;

/** `Base_Sepolia` reads badly in a dropdown. */
export function chainLabel(name: CctpChainName): string {
  return name.replace(/_/g, ' ');
}

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

/**
 * Progress boundaries a caller can render. `attest` is reported the moment the burn
 * is confirmed and the wait for Circle begins -- it is the longest part of a
 * transfer by far, and without it the UI shows a finished burn and then nothing.
 */
export type CctpStep = 'quote' | 'approve' | 'burn' | 'attest' | 'forward';

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

  // A wallet on the wrong network would read a balance from the wrong USDC contract
  // and sign a burn that cannot succeed. Say which network, not "something failed".
  const connected = clients.walletClient.chain?.id;
  if (connected != null && connected !== src.chainId) {
    throw new Error(
      `This wallet is on chain ${connected}. Switch it to ${chainLabel(params.from)} (chain ${src.chainId}) to bridge from there.`,
    );
  }

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

  params.onStep?.('attest', burnTxHash);
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
 * Ask Circle once whether it has submitted the destination mint for this burn.
 *
 * The question is answerable from the burn hash alone, at any time, by anyone. That
 * is what makes a stalled transfer recoverable rather than lost: whoever holds the
 * hash -- a browser that reloaded, a phone that was closed, a support ticket -- can
 * ask again later and find out where the money went.
 *
 * Undefined means "not yet", never "gone". The burn is on chain and the attestation
 * does not expire, so a transfer that has not minted is a transfer still in flight.
 */
export async function findForwardedMint(params: {
  sourceDomain: number;
  burnTxHash: Hex;
  fetchImpl?: typeof fetch;
}): Promise<Hex | undefined> {
  const doFetch = params.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `${IRIS_TESTNET}/v2/messages/${params.sourceDomain}?transactionHash=${params.burnTxHash}`,
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { messages?: { forwardTxHash?: string }[] };
    return body.messages?.find((m) => m.forwardTxHash)?.forwardTxHash as Hex | undefined;
  } catch {
    // A failed poll is not a failed transfer.
    return undefined;
  }
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
  const deadline = Date.now() + (params.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    const hash = await findForwardedMint(params);
    if (hash) return hash;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return undefined;
}
