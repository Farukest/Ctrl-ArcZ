import {
  erc20Abi,
  pad,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { CCTP_CHAINS, chainLabel, type CctpChainName } from './cctp.js';
// Circle's cap on one transfer request. It lives with the allocator because that
// is what has to respect it while choosing a split; the import is one-way, since
// `allocate.ts` takes only a type from here.
import { MAX_INTENTS } from './allocate.js';

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
  /**
   * Several burns, one signature.
   *
   * This is what makes drawing on more than one chain bearable. A Gateway
   * balance is unified for reading but spent per chain, so paying more than one
   * chain's deposit can cover takes one intent per chain; without this type that
   * would be one wallet prompt per chain, and a four-chain payment nobody would
   * finish. With it the user approves once however many chains are involved.
   *
   * The struct is a single dynamic array, so the encoding follows from
   * `BurnIntent` and needs nothing else declared.
   */
  BurnIntentSet: [{ name: 'intents', type: 'BurnIntent[]' }],
} as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/**
 * bigint values have to reach Circle as decimal strings, not JSON numbers.
 *
 * The obvious way to write this is a `JSON.stringify` replacer that tests for
 * `typeof v === 'bigint'`, and it is not safe. `JSON.stringify` calls a value's
 * `toJSON` BEFORE handing it to the replacer, so anything that defines
 * `BigInt.prototype.toJSON` decides what we send and the replacer is handed a
 * string it has no reason to touch. That is not hypothetical: a browser extension
 * that returns `${this}n` turned `"value":"1000000"` into `"value":"1000000n"`,
 * Circle refused the estimate with "Must be a valid positive integer string", and
 * the subscription page could neither price nor create anything. Nothing in this
 * repo or its dependencies patches that prototype; the page does not get to
 * choose its neighbours, so the serialiser has to survive them.
 *
 * So the conversion happens here, before `JSON.stringify` is ever given a bigint,
 * and it converts with a template literal rather than `v.toString()`: ToString on
 * a bigint is an internal operation, while `.toString()` is one more method a
 * third party can redefine.
 */
function toWire(value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}`;
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));
  }
  return value;
}

function jsonBigints(value: unknown): string {
  return JSON.stringify(toWire(value));
}

/**
 * The sentence Circle actually wrote, not the envelope around it.
 *
 * Errors come back as `{"success":false,"message":"..."}` and that message is a
 * real sentence meant for a person. Printing the whole body puts JSON punctuation
 * and a status code in front of it, which reads like a crash rather than an answer.
 */
/**
 * The shortfall Circle names when it refuses a maxFee, in subunits.
 *
 * It rejects with "Insufficient total maxFee across intents to cover forwarding
 * fee. Required additional: 0.000565", which is the exact number needed and
 * better than any buffer that could be guessed at. Null when the message is
 * about something else, so the caller re-throws rather than retrying blind.
 */
function requiredAdditional(message: string): bigint | null {
  const m = /required additional:\s*([0-9]*\.?[0-9]+)/i.exec(message);
  if (!m?.[1]) return null;
  try {
    return parseUnits(m[1], 6);
  } catch {
    return null;
  }
}

async function circleMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { message?: string };
    if (body.message) return body.message;
  } catch {
    // Not JSON. Fall through to the raw text, which is better than nothing.
  }
  return text ? `${fallback}: ${text.slice(0, 200)}` : `${fallback} (${res.status}).`;
}

/** USDC subunits as a readable figure, for the messages a person has to act on. */
function usdc(v: bigint): string {
  return String(Number(v) / 1e6);
}

/**
 * True when this "transfer" is really money coming back out to the same wallet on
 * the chain it was deposited on. Worth naming, because a caller should not present
 * it as a transfer and Circle prices it differently.
 */
export function isGatewayWithdrawal(params: { from: GatewayChain; to: GatewayChain }): boolean {
  return params.from === params.to;
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
    /*
     * The API reports a decimal figure ("1.500000"), not subunits, and it has to
     * be read exactly. The obvious `Math.round(Number(x) * 1e6)` is a float
     * round-trip on money: it can round a balance UP, which makes every check
     * downstream believe there is a subunit that is not there and produces an
     * intent Circle refuses after the user has signed. Above 2^53 subunits it
     * simply loses digits. `parseUnits` does the arithmetic on the string.
     */
    const subunits = toSubunits(entry.balance);
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

/**
 * Headroom added to Circle's quoted fee before it is signed.
 *
 * `maxFee` is a ceiling, not a price: Circle charges what the transfer actually
 * costs and ignores the rest, so widening it is free. It has to be widened, because
 * the fee drifts between quoting and settling and the signature locks in whatever
 * number was signed. With a local key that gap is a second and never shows; with a
 * wallet the user has to switch app, unlock and approve, and two minutes later
 * Circle refuses with "Insufficient total maxFee across intents. Required
 * additional: 0.000034". No money moves, but the transfer is dead and the whole
 * flow starts over, which is a miserable way to lose three cents of headroom.
 */
/** Floor, for when Circle returns no fee breakdown to size the buffer against. */
const FEE_MARGIN_MIN = 5_000n; // 0.005 USDC

/** A decimal USDC figure from Circle ("0.015494") as subunits. Bad input is 0n. */
function toSubunits(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return parseUnits(value, 6);
  } catch {
    return 0n;
  }
}

/**
 * The headroom to sign over Circle's quote.
 *
 * Not a percentage, and not a guess. Circle's own formula is
 *
 *     maxFee >= gas fee + forwarding fee + (transfer amount * 0.00005)
 *
 * and the guidance printed beside it is to "add a buffer to your maxFee
 * calculation to account for gas fee fluctuations". So the part that moves is
 * the gas, and the estimate response names it: `perIntent[].baseFee` is the
 * source chain's gas and `forwardingFee` carries the destination's. The transfer
 * fee is a fixed fraction of the amount and does not move at all.
 *
 * The buffer is therefore the whole gas-bearing part over again, which absorbs a
 * doubling of gas between quoting and submitting. It costs the sender nothing:
 * `maxFee` is a ceiling, Circle charges what the transfer actually cost and
 * ignores the rest. Measured on Arc->Base: 0.056654 signed, 0.055489 taken.
 *
 * The percentage this replaces was not enough in practice. On a 0.0178 fee a 2%
 * pad offers 0.000356, so its 0.0005 floor applied, and Circle came back asking
 * for 0.000565 more. That is a rejection after the signature, and on the
 * subscription route it landed after the box had already been deployed: a box on
 * chain with no money in it.
 */
function withMargin(quoted: bigint, gasPart: bigint): bigint {
  return quoted + (gasPart > FEE_MARGIN_MIN ? gasPart : FEE_MARGIN_MIN);
}

/**
 * How much more in fees a refusal is allowed to talk us into.
 *
 * When Circle rejects a `maxFee` it names the exact shortfall, and taking that
 * number is better than guessing at a buffer. But taking it *unbounded* is a
 * signature over whatever the answer says: `maxFee` is a ceiling, so a reply of
 * "required additional: 500.0" would authorise 500 USDC of fees out of the
 * user's balance, and the person approving sees an EIP-712 struct they have no
 * way to audit.
 *
 * The refusal is a fee that moved between quoting and submitting, which is cents
 * on every route measured. So the top-up may be as large as the ceiling already
 * quoted -- generous enough that a genuine doubling of gas still goes through in
 * one retry -- with a floor so that routes whose whole fee is a tenth of a cent
 * still have room to absorb a real one.
 */
const FEE_TOPUP_FLOOR = 100_000n; // 0.10 USDC

function topUpCeiling(quotedCeiling: bigint): bigint {
  return quotedCeiling > FEE_TOPUP_FLOOR ? quotedCeiling : FEE_TOPUP_FLOOR;
}

/** One chain's share of a spend. A single-chain spend is a one-element list. */
export interface GatewaySource {
  chain: GatewayChain;
  /** What this chain contributes to the amount, before its own fee, in subunits. */
  value: bigint;
}

/** What one leg costs and how long its own source chain leaves it valid. */
export interface GatewayLegQuote {
  chain: GatewayChain;
  value: bigint;
  /** This leg's signed ceiling. */
  maxFee: bigint;
  quotedFee: bigint;
  /**
   * Per leg, not per transfer. Every intent expires against the block height of
   * its OWN source chain, and those run at different speeds; one number for all
   * of them would be the wrong number for all but one.
   */
  maxBlockHeight: bigint;
}

export interface GatewayQuote {
  /**
   * What gets signed, summed over the legs: Circle's quote plus headroom. A
   * ceiling, not a price, so the balance has to cover it even though less will
   * be taken.
   */
  maxFee: bigint;
  /** Circle's unpadded figure, for showing a fee that matches what is charged. */
  quotedFee: bigint;
  /** The earliest expiry among the legs, which is the one that binds. */
  maxBlockHeight: bigint;
  /** amount + maxFee, which is what the Gateway balance has to cover. */
  total: bigint;
  /**
   * The destination's forwarding fee, charged once for the transfer.
   *
   * Exposed because it is what `allocate()` needs and the only part of the cost
   * that has to be asked for: base fees are a measured table, but forwarding is
   * set by the destination and drifts with its gas -- about 0.016 into Arc
   * against 0.054 into Avalanche, and two percent between two reads minutes
   * apart. A cached one is a wrong one.
   */
  forwarding: bigint;
  /** Ordered as the legs were passed. The first carries the forwarding fee. */
  legs: GatewayLegQuote[];
}

/**
 * Normalise the two ways a caller can name where the money comes from.
 *
 * `from` + `amount` is the single-chain shorthand and stays exactly as it was.
 * `sources` is the general case. Keeping one internal shape means the multi-leg
 * path is not a second implementation that can drift from the first: a
 * single-chain spend is a one-element list and takes the same code.
 */
function toSources(params: {
  from?: GatewayChain;
  sources?: readonly GatewaySource[];
  amount?: bigint;
}): GatewaySource[] {
  if (params.sources && params.sources.length > 0) return [...params.sources];
  if (params.from == null || params.amount == null) {
    throw new Error('A Gateway spend needs either a source chain and amount, or a list of sources.');
  }
  return [{ chain: params.from, value: params.amount }];
}

/**
 * Everything about a set of legs that must be true before it is signed.
 *
 * Measured against Circle rather than assumed, because the two answers differ
 * and only one of them is enforced on their side:
 *
 *   - **Destination.** Circle refuses a set whose legs disagree:
 *     "All burn intents in a request must have the same destination domain".
 *     Checked here anyway, so a builder bug reads as a sentence instead of an
 *     HTTP 400 after the wallet has opened.
 *   - **Recipient.** Circle does NOT refuse it. A set with two recipients was
 *     accepted and settled (transferId 22a4a205-a142-485a-b788-be67349ee649):
 *     one signature paid two different addresses. That makes "who gets the
 *     money" a per-leg field under a single approval, which is exactly the kind
 *     of thing a user cannot audit in a wallet prompt. So every leg is built
 *     from one recipient here and there is no parameter that could vary it.
 *
 * A zero-value leg is refused for a duller reason: it pays a base fee to move
 * nothing.
 */
function assertSources(sources: readonly GatewaySource[]): void {
  if (sources.length === 0) throw new Error('A Gateway spend needs at least one source chain.');
  if (sources.length > MAX_INTENTS) {
    throw new Error(
      `A Gateway transfer can draw on at most ${MAX_INTENTS} chains, and this one names ${sources.length}.`,
    );
  }
  const seen = new Set<GatewayChain>();
  for (const s of sources) {
    if (s.value <= 0n) {
      throw new Error(`The ${chainLabel(s.chain)} leg is ${usdc(s.value)} USDC, which moves nothing.`);
    }
    if (seen.has(s.chain)) {
      throw new Error(`${chainLabel(s.chain)} appears twice in the same transfer.`);
    }
    seen.add(s.chain);
  }
}

/**
 * Price the spend before signing it.
 *
 * Measured against Circle's testnet endpoint rather than assumed: the fee came back
 * identical for 1, 5 and 200 USDC. It is a flat charge for the burn and the
 * forwarded mint, not a percentage, so a large transfer costs the same as a small
 * one and the balance needs only the amount plus a few cents.
 *
 * With several legs the shape is the same, one estimate request for the whole
 * set, and the headroom is worked out per leg. It has to be: `forwardingFee` is
 * charged once and lands on the FIRST leg, so a margin spread evenly over the
 * legs pads the small ones for nothing and leaves the first one short.
 */
export async function quoteGatewaySpend(params: {
  /** The single-chain shorthand. Use `sources` for more than one. */
  from?: GatewayChain;
  sources?: readonly GatewaySource[];
  to: GatewayChain;
  amount?: bigint;
  depositor: Address;
  recipient?: Address;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<GatewayQuote> {
  const doFetch = params.fetchImpl ?? fetch;
  const sources = toSources(params);
  assertSources(sources);
  const recipient = params.recipient ?? params.depositor;

  const specs = sources.map((s) =>
    buildSpec({
      from: s.chain,
      to: params.to,
      depositor: params.depositor,
      recipient,
      amount: s.value,
      // A placeholder: an estimate is not signed and Circle prices the route,
      // not the salt. The salts that matter are minted per intent at signing.
      salt: pad('0x01', { size: 32 }),
    }),
  );

  const res = await doFetch(
    `${params.apiBase ?? GATEWAY_API_TESTNET}/v1/estimate?enableForwarder=true`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBigints(specs.map((spec) => ({ spec }))),
    },
  );
  if (!res.ok) throw new Error(await circleMessage(res, 'Could not price this transfer'));
  const body = (await res.json()) as {
    body?: { burnIntent?: { maxFee: string; maxBlockHeight: string } }[];
    /** The same figure, broken into the parts Circle's fee page names. */
    fees?: { perIntent?: { baseFee?: string }[]; forwardingFee?: string };
  };
  if ((body.body?.length ?? 0) !== sources.length) {
    throw new Error('Circle did not quote this Gateway route.');
  }

  const forwarding = toSubunits(body.fees?.forwardingFee);
  const legs: GatewayLegQuote[] = sources.map((s, i) => {
    const estimate = body.body?.[i]?.burnIntent;
    if (!estimate) throw new Error('Circle did not quote this Gateway route.');
    const quotedFee = BigInt(estimate.maxFee);
    // Source gas plus, on the first leg only, the forwarding fee that carries
    // the destination's gas. What is left of the total is the transfer fee,
    // which is a fixed fraction of the amount and cannot drift, so it needs no
    // headroom.
    const gasPart =
      toSubunits(body.fees?.perIntent?.[i]?.baseFee) + (i === 0 ? forwarding : 0n);
    return {
      chain: s.chain,
      value: s.value,
      quotedFee,
      maxFee: withMargin(quotedFee, gasPart),
      maxBlockHeight: BigInt(estimate.maxBlockHeight),
    };
  });

  const maxFee = legs.reduce((sum, l) => sum + l.maxFee, 0n);
  const quotedFee = legs.reduce((sum, l) => sum + l.quotedFee, 0n);
  const amount = sources.reduce((sum, s) => sum + s.value, 0n);
  // The earliest expiry binds the whole set: past it, that one intent is stale
  // and Circle will not take the request however fresh the others are.
  const maxBlockHeight = legs.reduce(
    (min, l) => (l.maxBlockHeight < min ? l.maxBlockHeight : min),
    legs[0]!.maxBlockHeight,
  );

  return { maxFee, quotedFee, maxBlockHeight, total: amount + maxFee, forwarding, legs };
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
 *
 * `from` and `to` may be the same chain, and that case is not a mistake to be
 * refused: it is the way money comes back out. Same-chain means Circle debits the
 * balance and mints straight back to the wallet on that chain, which is the only
 * quick exit a depositor has. Rejecting it, as this did, left a door that money
 * could go in but not out of -- the only way back to the chain you started on was
 * to bridge away and bridge home, paying twice to end up where you began.
 * Measured: it settles in about seven seconds and costs roughly a third of a
 * cross-chain transfer, because Circle charges no transfer fee within one chain.
 */
export async function spendFromGateway(
  clients: { walletClient: WalletClient },
  params: {
    /** The single-chain shorthand. Use `sources` to draw on more than one. */
    from?: GatewayChain;
    /**
     * Where the money comes from, one entry per chain.
     *
     * A Gateway balance reads as one figure and spends per chain, so a wallet
     * with enough in total can still be unable to pay from any single chain.
     * Naming several sources fixes that, and costs the user nothing extra to
     * approve: the intents are signed together as one `BurnIntentSet`.
     *
     * Use `allocate()` to work out the split rather than assembling it by hand;
     * the leg ORDER carries the forwarding fee and is not cosmetic.
     */
    sources?: readonly GatewaySource[];
    to: GatewayChain;
    amount?: bigint;
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
    /**
     * Injectable so salts can be pinned in tests; random otherwise.
     *
     * One salt per intent. Reusing one across a set would hand Circle several
     * specs that differ only by source, which is the shape of a duplicate rather
     * than of four legs of one payment.
     */
    salt?: Hex;
    salts?: readonly Hex[];
  },
): Promise<GatewaySpendResult> {
  const account = clients.walletClient.account;
  if (!account) throw new Error('No wallet account to spend from.');

  const sources = toSources(params);
  assertSources(sources);
  const amount = sources.reduce((sum, s) => sum + s.value, 0n);
  if (amount <= 0n) throw new Error('Amount must be positive.');

  const apiBase = params.apiBase ?? GATEWAY_API_TESTNET;
  const doFetch = params.fetchImpl ?? fetch;
  const recipient = params.recipient ?? account.address;

  params.onStep?.('quote');
  const quote = await quoteGatewaySpend({
    sources,
    to: params.to,
    depositor: account.address,
    recipient,
    apiBase,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });

  /**
   * Refuse before signing when the balance cannot cover it, and check each leg
   * against the balance that actually pays it: the one on that leg's own chain.
   *
   * "Unified balance" is unified for reading, not for spending. One intent names one
   * `sourceDomain` and draws only from that chain's deposit. Measured against Circle:
   * an intent sourced on Ethereum came back "available 0, required 1.114129" while
   * the same depositor held plenty on Arc. Comparing against the total would pass the
   * check and then be rejected after the user had signed -- which defeats the whole
   * point of checking first, and drawing on several chains does not change it: a set
   * is refused if any one of its legs is short.
   *
   * Circle's own estimate is no help here. Asked to price 1000 USDC out of a chain
   * holding 17.2 it returned an ordinary quote, so this is the only check there is.
   */
  const balance = await gatewayBalance({
    depositor: account.address,
    apiBase,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  for (const leg of quote.legs) {
    const here = balance.byChain[leg.chain] ?? 0n;
    const needed = leg.value + leg.maxFee;
    if (here >= needed) continue;
    const label = chainLabel(leg.chain);
    const elsewhere = balance.total - here;
    throw new Error(
      `Your Gateway balance on ${label} is ${usdc(here)} USDC and this transfer draws ${usdc(needed)} from it including the ${usdc(leg.maxFee)} fee.` +
        (elsewhere > 0n
          ? ` You hold ${usdc(elsewhere)} on other chains; a transfer can draw on several of them at once, but each leg spends only what is deposited on its own chain.`
          : ` Deposit on ${label} first.`),
    );
  }

  const salts =
    params.salts ?? sources.map((_, i) => (i === 0 && params.salt ? params.salt : randomSalt()));
  if (new Set(salts).size !== sources.length) {
    throw new Error('Each leg of a Gateway transfer needs its own salt.');
  }
  const specs = sources.map((s, i) =>
    buildSpec({
      from: s.chain,
      to: params.to,
      depositor: account.address,
      recipient,
      amount: s.value,
      salt: salts[i] as Hex,
    }),
  );

  /**
   * Sign the intents and hand them to Circle, once more if it names a shortfall.
   *
   * One leg is signed as a `BurnIntent`, several as a `BurnIntentSet`, and the
   * two shapes are not interchangeable: Circle reads the array element as
   * `burnIntent` or `burnIntentSet` and rejects a top-level object outright with
   * "Expected array, received object". A set is still ONE signature, which is
   * the whole reason drawing on four chains is something a person will finish.
   *
   * The fee can move between quoting and submitting, and with a wallet that gap
   * is however long the user takes to approve. When it moves past the ceiling,
   * Circle refuses and says by how much, which is a better number than any
   * buffer: it is the answer rather than an estimate of it. So the second
   * attempt uses Circle's own figure instead of widening blindly, and there is
   * no third, because a shortfall that survives being told the exact amount is
   * not a fee that drifted. Circle checks the TOTAL across intents, so the
   * top-up goes on the first leg and slack anywhere in the set counts toward it.
   *
   * Re-signing is required rather than optional: `maxFee` is inside the signed
   * struct, so a new ceiling is a new signature.
   */
  const submit = async (topUp: bigint) => {
    const intents = quote.legs.map((leg, i) => ({
      maxBlockHeight: leg.maxBlockHeight,
      maxFee: leg.maxFee + (i === 0 ? topUp : 0n),
      spec: specs[i],
    }));
    // Cast wholesale: viem infers the message shape from `types`, and BurnIntent's
    // nested TransferSpec does not survive that inference. The shape is pinned by the
    // TYPES table above and asserted in the tests instead.
    const single = intents.length === 1;
    const signature = await clients.walletClient.signTypedData({
      account,
      domain: EIP712_DOMAIN,
      types: TYPES,
      primaryType: single ? 'BurnIntent' : 'BurnIntentSet',
      message: single ? intents[0] : { intents },
    } as never);
    params.onStep?.('sign');
    return doFetch(`${apiBase}/v1/transfer?enableForwarder=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBigints([
        single ? { burnIntent: intents[0], signature } : { burnIntentSet: { intents }, signature },
      ]),
    });
  };

  let res = await submit(0n);
  if (!res.ok) {
    const reason = await circleMessage(res, 'Gateway refused the transfer');
    const short = requiredAdditional(reason);
    if (short == null) throw new Error(reason);
    if (short > topUpCeiling(quote.maxFee)) {
      /*
       * A drift is cents. A figure larger than the whole ceiling already signed
       * is not a fee that moved, and re-signing it would authorise Circle -- or
       * anything answering in its place -- to take it. `maxFee` is a ceiling, so
       * whatever is asked for here is what could be spent, which makes this the
       * one number in the flow that must not be accepted on trust.
       */
      throw new Error(
        `Gateway asked for ${usdc(short)} USDC more in fees than the ${usdc(quote.maxFee)} already quoted. That is not a fee that drifted, so nothing was signed.`,
      );
    }
    res = await submit(short);
    if (!res.ok) throw new Error(await circleMessage(res, 'Gateway refused the transfer'));
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
