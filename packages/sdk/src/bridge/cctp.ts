import {
  encodeFunctionData,
  erc20Abi,
  pad,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { GENERATED_CHAINS, type GeneratedChain } from '../chains/circleChains.generated.js';

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

/** Arc's chain id, spelled out here because `arcTestnet.ts` imports this file. */
const ARC_CHAIN_ID = 5042002;

/** Chains this can bridge between, with the three facts the burn needs. */
export interface CctpChain {
  /** CCTP domain id. Not a chain id; the two are unrelated numbers. */
  domain: number;
  /** EVM chain id, so a caller can check the wallet is on the right network first. */
  chainId: number;
  /** USDC on that chain. */
  usdc: Address;
  /**
   * Set where gas is paid in the same USDC being bridged, which is Arc and nowhere
   * else here. It changes the affordability question rather than decorating it: on
   * Arc the transfer and its gas come out of one balance, so they have to be checked
   * against that one balance together. Checking them separately would wave through a
   * wallet that can pay for the transfer and then cannot pay to send it.
   */
  gasToken?: 'usdc';
}

/**
 * Every testnet Circle serves, read out of Circle's own table rather than typed.
 *
 * The domain, the chain id and the USDC address used to be written here by hand and
 * checked chain by chain -- `symbol() == USDC`, `decimals() == 6`, the reported chain
 * id, code at the TokenMessenger. That was honest work and it was correct: when this
 * moved to Circle's published table, every one of the twenty rows matched exactly.
 * What it could not do was notice Circle adding a network, and five had been added.
 *
 * So the facts come from `circleChains.generated.ts`, which is written out of
 * `@circle-fin/bridge-kit` -- the same table Circle's App Kit answers
 * `getSupportedChains` from. `chainTable.test.ts` fails if the checked-in copy and
 * the installed kit disagree.
 *
 * Listing a chain is not a promise Circle will forward on that route -- `quoteBridge`
 * asks per transfer and refuses out loud when the answer is no.
 */
export const CCTP_CHAINS = Object.fromEntries(
  GENERATED_CHAINS.map((c) => [
    c.name,
    {
      domain: c.domain,
      chainId: c.chainId,
      usdc: c.usdc as Address,
      /*
       * Ours, not Circle's: Arc is the only chain that bills gas in the token being
       * moved. Keyed by chain id rather than by name so an alias cannot lose it.
       */
      ...(c.chainId === ARC_CHAIN_ID ? { gasToken: 'usdc' as const } : {}),
    },
  ]),
) as Record<CctpChainName, CctpChain>;

/**
 * Every chain name this app knows, as a union.
 *
 * Taken from the generated array rather than from `CCTP_CHAINS`, which is now built
 * at load time and would widen to `string`. Three of these are this project's own
 * names for a chain Circle calls something else; `circleName` records the pairing
 * and the alias is kept because these names are written into stored activity rows.
 */
export type CctpChainName = (typeof GENERATED_CHAINS)[number]['name'];

/** `Base_Sepolia` reads badly in a dropdown. */
export function chainLabel(name: CctpChainName): string {
  return name.replace(/_/g, ' ');
}

/** The generated row for a chain, which the lookups below all read. */
const ROW: ReadonlyMap<CctpChainName, GeneratedChain> = new Map(
  GENERATED_CHAINS.map((c) => [c.name, c]),
);

/** Built once from the table above, so the two can never list different ids. */
const CHAIN_ID_TO_NAME: ReadonlyMap<number, CctpChainName> = new Map(
  (Object.keys(CCTP_CHAINS) as CctpChainName[]).map((name) => [CCTP_CHAINS[name].chainId, name]),
);

/**
 * Which of these chains a wallet reporting `chainId` is standing on.
 *
 * The inverse of the table, and the question every chain-aware control on a screen
 * actually asks: the wallet answers `eth_chainId` with a number, and everything
 * else in this codebase is keyed by name. Written out here rather than as a loop at
 * each call site, because a control that gets this wrong does not fail -- it shows
 * a different network's balance under the right label.
 *
 * Undefined for a chain Circle does not serve, which is a real state: the wallet
 * can be on any network at all, and "we have no entry for it" is the honest answer
 * rather than falling back to Arc.
 */
export function cctpChainByChainId(chainId: number | undefined): CctpChainName | undefined {
  return chainId === undefined ? undefined : CHAIN_ID_TO_NAME.get(chainId);
}

/**
 * Public read endpoints for chains this project has NOT deployed on.
 *
 * Read endpoints belong to a chain, not to our deployment on it. That distinction
 * was missing: `rpcUrls` lived only inside `DEPLOYMENTS`, so the five chains
 * carrying our contracts could be read from anywhere and the other six could only
 * be read while the wallet happened to be standing on them. Gateway serves all
 * eleven, so the app was calling money unreadable on six chains for a reason that
 * had nothing to do with those chains.
 *
 * Every endpoint below was probed on 2026-08-27 before being written down, on the
 * same terms as the USDC addresses above: it must report the expected chain id,
 * have code at that chain's USDC address, and answer a real `balanceOf`. Polygon's
 * own `rpc-amoy.polygon.technology` did not answer at all and is deliberately
 * absent; the two that did are here instead.
 *
 * More than one where more than one answered, so a single throttled endpoint
 * cannot blank a balance.
 */
const READ_RPCS: Partial<Record<CctpChainName, readonly string[]>> = {
  OP_Sepolia: ['https://sepolia.optimism.io', 'https://optimism-sepolia-rpc.publicnode.com'],
  Polygon_Amoy: [
    'https://polygon-amoy-bor-rpc.publicnode.com',
    'https://polygon-amoy.drpc.org',
  ],
  Unichain_Sepolia: ['https://sepolia.unichain.org', 'https://unichain-sepolia-rpc.publicnode.com'],
  Sonic_Testnet: ['https://rpc.testnet.soniclabs.com'],
  World_Chain_Sepolia: [
    'https://worldchain-sepolia.g.alchemy.com/public',
    'https://worldchain-sepolia.gateway.tenderly.co',
  ],
  Sei_Testnet: ['https://evm-rpc-testnet.sei-apis.com'],

  /*
   * The nine that were left, added 2026-08-29 to the same standard as the six
   * above: every one reports its expected chain id, has code at that chain's USDC
   * address, and answers a real `balanceOf`. They were the difference between "the
   * app can reach eleven of Circle's twenty testnets" and all twenty, which matters
   * most for a CCTP burn -- that spends the wallet's own USDC on the source chain,
   * so the source is wherever their money is and not one of eleven we happened to
   * have endpoints for.
   *
   * Two where two answered. Monad's `monad-testnet.drpc.org` reported the right
   * chain and the right code but refused the `balanceOf` with "user-specified gas
   * exceeds provider limit", so it is deliberately absent rather than listed as a
   * fallback that fails on the one call this is for. Polygon's own
   * `rpc-amoy.polygon.technology` is absent for the same kind of reason, recorded
   * above.
   */
  Linea_Sepolia: ['https://rpc.sepolia.linea.build', 'https://linea-sepolia-rpc.publicnode.com'],
  Codex_Testnet: ['https://rpc.codex-stg.xyz'],
  Monad_Testnet: ['https://testnet-rpc.monad.xyz'],
  XDC_Apothem: ['https://erpc.apothem.network', 'https://rpc.apothem.network'],
  Ink_Testnet: ['https://rpc-gel-sepolia.inkonchain.com'],
  Plume_Testnet: ['https://testnet-rpc.plume.org'],
  Injective_Testnet: ['https://k8s.testnet.json-rpc.injective.network'],
  Cronos_Testnet: ['https://evm-t3.cronos.org', 'https://cronos-testnet.drpc.org'],
  Morph_Hoodi: ['https://rpc-hoodi.morphl2.io'],
};

/**
 * The one endpoint per chain that may be written into somebody's wallet.
 *
 * Deliberately not a read endpoint, and that distinction is why this exists at all.
 * The read lists are what this app dials for itself, and a community proxy is fine
 * there: it answers a balance, the answer is checked against a contract, and nothing
 * about the user travels with it. An endpoint stored in a wallet is a different
 * thing. It stays there, every other site the user visits on that chain goes through
 * it, and whoever runs it sees all of it.
 *
 * So this is Circle's published list for the chain, filtered to the endpoint on the
 * chain's own domain, and never publicnode, drpc, Alchemy, Tenderly or thirdweb
 * however well they answer. One each rather than a list, because a fallback here is
 * a second party seeing the same traffic. The filtering happens in the generator, so
 * the answer moves when Circle's list does.
 *
 * Four chains publish nothing of their own and are therefore never offered:
 * Ethereum Sepolia, which never had a chain-owned RPC and ships in every wallet
 * anyway; Polygon Amoy, whose `rpc-amoy.polygon.technology` stopped resolving in
 * DNS; and World Chain Sepolia and Edge, where Circle itself lists only resellers.
 */
export function firstPartyRpc(chain: CctpChainName): string | undefined {
  return ROW.get(chain)?.firstPartyRpc;
}

/**
 * What a chain charges gas in, for the one request that has to name it.
 *
 * Only `wallet_addEthereumChain` needs this; everything else in the app either pays
 * in USDC or lets the wallet decide. It was typed out of viem's registry once and
 * disagreed with the EIP-155 registry on Cronos, which is the sort of difference a
 * wallet turns into a warning. Circle publishes it per chain, so it is read there.
 */
export function chainNativeCurrency(
  chain: CctpChainName,
): { readonly name: string; readonly symbol: string; readonly decimals: number } | undefined {
  return ROW.get(chain)?.nativeCurrency;
}

/**
 * Endpoints that can answer public reads for a chain we have not deployed on.
 *
 * Empty for a chain nothing here can reach, which is a real answer: the caller
 * has to say it cannot read rather than read the wrong chain. Chains we did
 * deploy on carry their own list in `DEPLOYMENTS` and do not appear here.
 */
export function publicReadRpcs(chain: CctpChainName): readonly string[] {
  /*
   * Ours first, then Circle's, deduped.
   *
   * Both halves earn their place. Circle publishes an endpoint for every chain it
   * serves, so a newly added network is readable the moment the table is
   * regenerated rather than when somebody remembers to probe one. The list above
   * is what this app measured on top of that: a second endpoint where a second one
   * answered, which is what stops one throttled provider blanking a balance, and a
   * couple that Circle does not list at all.
   *
   * Ours lead because they were checked against this chain's own USDC contract,
   * not merely published.
   */
  return [...new Set([...(READ_RPCS[chain] ?? []), ...(ROW.get(chain)?.rpcEndpoints ?? [])])];
}

/*
 * Explorers come from the generated table now. They used to be typed out of viem's
 * registry, which was right for the chains it knew and silent about Sonic and Morph;
 * Circle publishes one for every chain it serves, as a link template with the hash
 * in it. The template matters: most chains put a transaction under `/tx/`, Injective
 * uses `/transaction/`, and X Layer nests it under a per-chain path, so a link built
 * by gluing `/tx/` onto a front page was wrong on two of them.
 */

/**
 * Where to look this transaction up, or undefined when no explorer is known.
 *
 * Undefined is the honest answer for a chain with no published explorer, and the
 * caller should render no link rather than a broken one.
 */
export function chainExplorerTxUrl(chain: CctpChainName, txHash: string): string | undefined {
  const template = ROW.get(chain)?.explorerTx;
  return template ? template.replace('{hash}', txHash) : undefined;
}

/** The explorer's own front page for a chain, or undefined where none is known.
 *  Exposed so the deployment registry can point at one without restating it. */
export function chainExplorerUrl(chain: CctpChainName): string | undefined {
  return ROW.get(chain)?.explorerUrl;
}


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
     * What the transfer will cost, as soon as it is known.
     *
     * The quote is in the result too, and the result arrives when the whole
     * transfer does -- minutes after the burn, on a row that has been on screen
     * the entire time saying nothing about the fee. This fires the moment Circle
     * has quoted, which is before anything is signed, so a caller writing the
     * transfer down can write down what it costs at the same time.
     */
    onQuote?: (quote: BridgeQuote) => void;
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

  // Widened deliberately: `as const` narrows each entry to its own literal shape, so
  // `gasToken` would only be visible on the one chain that declares it.
  const src: CctpChain = CCTP_CHAINS[params.from];
  const dst: CctpChain = CCTP_CHAINS[params.to];
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
  params.onQuote?.(quote);

  // Refuse before signing anything if the wallet cannot cover the burn. The chain
  // would refuse too, but only after the user has approved a transaction.
  const balance = (await clients.publicClient.readContract({
    address: src.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;

  // Approve exactly the total. An unbounded approval to a contract that can move
  // USDC is a standing risk for a one-off transfer.
  const allowance = (await clients.publicClient.readContract({
    address: src.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, CCTP_TOKEN_MESSENGER],
  })) as bigint;

  const needsApproval = allowance < quote.total;
  const label = chainLabel(params.from);

  /**
   * Gas is the other way this fails after the user has already approved something.
   *
   * Arc pays gas in the USDC being bridged, so there the transfer and its gas come
   * out of one balance and are checked against it together. Everywhere else the gas
   * is a separate native token the sender very often does not have -- USDC arrives
   * by bridging, ETH or AVAX does not -- so it gets its own check and its own
   * message naming the token, because "insufficient funds" sends someone to look at
   * the wrong balance.
   */
  const gasCost = await estimateBridgeGas(clients.publicClient, {
    account: account.address,
    usdc: src.usdc,
    needsApproval,
    total: quote.total,
  });

  if (src.gasToken === 'usdc') {
    // One balance, two representations, and they are not in the same unit. Arc's
    // native currency is USDC with 18 decimals while the ERC-20 at 0x3600.. reports
    // the same holdings with 6, so a gas figure in wei is 1e12 times too large to
    // add to a USDC figure. Measured on chain rather than assumed: native / 1e12
    // equals the ERC-20 balance exactly. Rounded up, because rounding gas down is
    // how a check like this passes a wallet that then cannot send.
    const gasInUsdc = (gasCost + NATIVE_PER_USDC - 1n) / NATIVE_PER_USDC;
    if (balance < quote.total + gasInUsdc) {
      throw new Error(
        `This wallet holds ${usdc(balance)} USDC on ${label}. The transfer needs ${usdc(quote.total)} including fees, plus about ${usdc(gasInUsdc)} for gas, which ${label} also charges in USDC.`,
      );
    }
  } else {
    if (balance < quote.total) {
      throw new Error(
        `This wallet holds ${usdc(balance)} USDC on ${label} and the transfer needs ${usdc(quote.total)} including fees.`,
      );
    }
    const native = await clients.publicClient.getBalance({ address: account.address });
    if (native < gasCost) {
      throw new Error(
        `This wallet has enough USDC, but ${label} charges gas in its own native token and this wallet holds ${formatGas(native)} of it. Sending the transfer needs about ${formatGas(gasCost)}. Fund the wallet with ${label} gas and try again.`,
      );
    }
  }

  let approveTxHash: Hex | undefined;
  if (needsApproval) {
    approveTxHash = await queued(account.address, src.chainId, () =>
      clients.walletClient.writeContract({
        address: src.usdc,
        abi: erc20Abi,
        functionName: 'approve',
        args: [CCTP_TOKEN_MESSENGER, quote.total],
        account,
        chain: clients.walletClient.chain ?? null,
      }),
    );
    await clients.publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    params.onStep?.('approve', approveTxHash);
  } else {
    params.onStep?.('approve');
  }

  const burnTxHash = await queued(account.address, src.chainId, () =>
    clients.walletClient.sendTransaction({
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
    }),
  );
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
 * Wei per USDC subunit on a chain whose gas token is USDC: 18 native decimals
 * against the ERC-20's 6. Verified against Arc rather than inferred, by reading the
 * same wallet both ways and confirming `native / 1e12 === balanceOf`.
 */
const NATIVE_PER_USDC = 10n ** 12n;

/**
 * One on-chain transaction at a time per signer, per chain.
 *
 * Two transfers started close together each ask the node for a nonce, get the same
 * one, and the second is rejected. It used to be impossible to hit because the UI
 * locked while a transfer ran; allowing a second transfer to start made it
 * reachable. Queuing is enough: these are two quick sends, not a throughput
 * problem, and serialising them is cheaper than tracking nonces ourselves.
 *
 * Keyed by signer and chain, so transfers on different chains still overlap.
 */
const sendQueues = new Map<string, Promise<unknown>>();

function queued<T>(signer: Address, chainId: number, work: () => Promise<T>): Promise<T> {
  const key = `${signer.toLowerCase()}:${chainId}`;
  const prev = sendQueues.get(key) ?? Promise.resolve();
  // Never let a failed transfer poison the queue for the next one.
  const next = prev.then(work, work);
  sendQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** USDC subunits as a readable figure. Six decimals, trailing zeros dropped. */
function usdc(v: bigint): string {
  return String(Number(v) / 1e6);
}

/** Native token wei as a readable figure. Kept short; this goes in a sentence. */
function formatGas(v: bigint): string {
  const eth = Number(v) / 1e18;
  return eth < 0.000001 ? '<0.000001' : eth.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * `depositForBurnWithHook` cannot be simulated before the approval exists, because
 * without an allowance it reverts. So the burn is not estimated at all: this is a
 * ceiling, used only to answer "can this wallet afford to send the transaction" and
 * never to cap the gas actually spent.
 *
 * A real burn on Arc used 121,652 gas, so this is roughly double. The headroom is
 * deliberate rather than lazy: on OP-stack chains (Base, OP, Ink, Unichain here) the
 * L1 data fee is a real cost that `estimateFeesPerGas` does not report, so a ceiling
 * tightened to the measured number would under-estimate on exactly the chains most
 * likely to be a source. Erring high turns away a wallet that was marginally
 * fundable; erring low takes someone's approval and strands them.
 */
const BURN_GAS_CEILING = 250_000n;

/** Approve is a plain ERC-20 write and does estimate cleanly, but not on every RPC. */
const APPROVE_GAS_CEILING = 80_000n;

/**
 * What it will cost to send this transfer, in the source chain's gas token.
 *
 * Covers both transactions when an approval is needed, since a wallet that can pay
 * for the approval and not the burn ends up in exactly the stranded state this whole
 * check exists to prevent.
 */
async function estimateBridgeGas(
  publicClient: PublicClient,
  params: { account: Address; usdc: Address; needsApproval: boolean; total: bigint },
): Promise<bigint> {
  let approveGas = 0n;
  if (params.needsApproval) {
    try {
      approveGas = await publicClient.estimateContractGas({
        address: params.usdc,
        abi: erc20Abi,
        functionName: 'approve',
        args: [CCTP_TOKEN_MESSENGER, params.total],
        account: params.account,
      });
    } catch {
      approveGas = APPROVE_GAS_CEILING;
    }
  }

  // Prefer the EIP-1559 estimate and fall back to a flat gas price, because several
  // of these testnets are not 1559 chains and the first call simply fails there.
  let pricePerGas: bigint;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    pricePerGas = fees.maxFeePerGas ?? (await publicClient.getGasPrice());
  } catch {
    pricePerGas = await publicClient.getGasPrice();
  }

  return (approveGas + BURN_GAS_CEILING) * pricePerGas;
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
