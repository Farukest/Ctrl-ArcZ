/**
 * Single source of truth for every Arc Testnet address, endpoint and chain
 * constant used anywhere in Ctrl+ArcZ (SDK, demo apps, Foundry deploy scripts).
 *
 * No address is hardcoded outside this file. Values are transcribed from the
 * Arc documentation, not from memory:
 *   - https://docs.arc.io/arc/references/contract-addresses
 *   - https://docs.arc.io/arc/references/connect-to-arc
 */
import { arcTestnet as viemArcTestnet } from 'viem/chains';

/** viem ships Arc Testnet as a built-in chain (requires viem >= 2.38). */
export const arcTestnet = viemArcTestnet;

export const ARC_TESTNET_CHAIN_ID = 5042002 as const;

export const RPC_URL = 'https://rpc.testnet.arc.network' as const;
/**
 * Public Arc Testnet RPC endpoints. The default one is aggressively rate-limited
 * (`-32011 request limit reached`) under load, so clients should spread requests
 * across this list with a fallback transport and move off any endpoint that limits
 * them. All are the same chain (5042002).
 */
/**
 * Ordered by measured reliability, not by name. Probed with 10 rapid
 * eth_blockNumber calls: drpc 10/10, blockdaemon 10/10, quicknode 6/10 (429),
 * the public endpoint 5/10. Putting a rate-limiting provider first made every
 * read pay the retry cascade before falling through, so the two clean providers
 * lead and the rate-limited ones are the last resort.
 */
export const RPC_URLS = [
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
  RPC_URL,
] as const;

/**
 * The same endpoints, ordered for a client that signs transactions.
 *
 * viem asks `eth_fillTransaction` while preparing every transaction. On Arc that
 * is not a nicety: the reply carries `feeToken`, which is how a chain that bills
 * gas in USDC tells the client what it is paying with. Two of the four public
 * endpoints refuse the method — drpc answers -32601, blockdaemon returns 403
 * "Request method filtered" — and a fallback transport hides the refusal by
 * moving on. So every send quietly paid two doomed round trips before reaching a
 * node that could answer, and the browser console filled with 400s and 403s that
 * read like the app was broken.
 *
 * Reads keep `RPC_URLS`, where the pair that filters here is genuinely the fastest.
 * The filtering pair stays at the back rather than being dropped: viem degrades to
 * individual fee calls when the method is refused, so they remain a usable last
 * resort if the two supporting endpoints are rate-limiting.
 */
export const SIGNING_RPC_URLS = [
  'https://rpc.quicknode.testnet.arc.network',
  RPC_URL,
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
] as const;

export const WS_URL = 'wss://rpc.testnet.arc.network' as const;
export const EXPLORER_URL = 'https://testnet.arcscan.app' as const;

/**
 * Blockscout-compatible REST API exposed by ArcScan. The schema is not part of
 * the Arc docs; it was verified against the live API.
 */
export const EXPLORER_API_URL = `${EXPLORER_URL}/api/v2` as const;

export const FAUCET_URL = 'https://faucet.circle.com' as const;

/**
 * Arc contract addresses (Testnet).
 * Source: https://docs.arc.io/arc/references/contract-addresses
 */
export const ADDRESSES = {
  /**
   * USDC ERC-20 interface over the native balance. 6 decimals on this
   * interface, 18 on the native one — never mix the two. Ctrl+ArcZ only ever
   * touches the ERC-20 interface, and reads `decimals()` from the contract.
   */
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',

  /** Attaches memo metadata to a call; must be invoked directly by an EOA. */
  MEMO: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
  /** Multicall3 that preserves the original msg.sender in each subcall. */
  MULTICALL3_FROM: '0x522fAf9A91c41c443c66765030741e4AaCe147D0',

  /** Standard Ethereum-ecosystem contracts, predeployed on Arc. */
  MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  CREATE2_FACTORY: '0x4e59b44847b379578588920cA78FbF26c0B4956C',

  /** Crosschain (CCTP v2 / Gateway), Arc domain 26. Unused by Ctrl+ArcZ v1. */
  CCTP_TOKEN_MESSENGER_V2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  CCTP_MESSAGE_TRANSMITTER_V2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  GATEWAY_WALLET: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',

  /** StableFX settlement escrow. Unused by Ctrl+ArcZ v1. */
  FX_ESCROW: '0x867650F5eAe8df91445971f14d89fd84F0C9a9f8',
} as const satisfies Record<string, `0x${string}`>;

/** Decimals of the USDC ERC-20 interface. Always cross-checked against `decimals()` at runtime. */
export const USDC_DECIMALS = 6 as const;

/**
 * The tokens this app will move on Arc Testnet.
 *
 * Every field was read off the chain, not copied from a table: `symbol()` and
 * `decimals()` were called on each address against the public RPC. That is the
 * same discipline `CCTP_CHAINS` documents and for the same reason -- a wrong
 * token address does not fail loudly, it moves real value into a contract that is
 * not the token.
 *
 * `searchNames` is ours, not the chain's. `name()` on both of these returns the
 * symbol again ("USDC", "EURC"), so there is no long name to show; these exist so
 * that typing "euro" or "dollar" finds the right row.
 *
 * USYC is deliberately absent. It is permissioned -- transfers are restricted to
 * an allowlist of institutions outside the US, minted through a Teller -- so
 * offering it here would put a token in the picker that most holders of this app
 * cannot send, and the failure would arrive as a revert.
 */
export interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
  /** Base units per whole token. Never assume 6; see `verifyToken`. */
  decimals: number;
  /** Extra words the picker's search should match. Ours, not the contract's. */
  searchNames: readonly string[];
}

export const ARC_TOKENS = [
  {
    symbol: 'USDC',
    address: ADDRESSES.USDC,
    decimals: 6,
    searchNames: ['usd coin', 'dollar', 'usd'],
  },
  {
    symbol: 'EURC',
    address: ADDRESSES.EURC,
    decimals: 6,
    searchNames: ['euro coin', 'euro', 'eur'],
  },
] as const satisfies readonly TokenInfo[];

export type ArcTokenSymbol = (typeof ARC_TOKENS)[number]['symbol'];

/** The default everywhere an amount is entered. Gas on Arc is USDC, so it is also
 *  the only token a wallet is guaranteed to need. */
export const DEFAULT_TOKEN: TokenInfo = ARC_TOKENS[0];

export function tokenByAddress(address: string): TokenInfo | undefined {
  const a = address.toLowerCase();
  return ARC_TOKENS.find((t) => t.address.toLowerCase() === a);
}

export function tokenBySymbol(symbol: string): TokenInfo | undefined {
  const s = symbol.toLowerCase();
  return ARC_TOKENS.find((t) => t.symbol.toLowerCase() === s);
}

/**
 * Does the chain agree with the row above?
 *
 * The registry is what the amount maths uses, so being wrong about `decimals` is
 * being wrong about how much money is moving by a factor of a hundred or more.
 * This is the check that turns that from a silent error into a refusal, and it is
 * why the caller should treat a mismatch as "do not offer this token" rather than
 * as a warning to log.
 *
 * Returns the reason rather than throwing: a picker that cannot reach the RPC
 * should say so, not fall over.
 */
export async function verifyToken(
  read: (address: `0x${string}`, selector: `0x${string}`) => Promise<string>,
  token: TokenInfo,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const [symbolHex, decimalsHex] = await Promise.all([
      read(token.address, '0x95d89b41'), // symbol()
      read(token.address, '0x313ce567'), // decimals()
    ]);
    const decimals = Number(BigInt(decimalsHex));
    if (decimals !== token.decimals) {
      return {
        ok: false,
        reason: `${token.symbol} at ${token.address} reports ${decimals} decimals, not ${token.decimals}.`,
      };
    }
    if (!decodeStringReturn(symbolHex).startsWith(token.symbol)) {
      return {
        ok: false,
        reason: `${token.address} does not call itself ${token.symbol}.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** ABI-decode a `string` return value. Enough for `symbol()`; not a general decoder. */
function decodeStringReturn(hex: string): string {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length < 128) return '';
  const length = Number(BigInt(`0x${body.slice(64, 128)}`));
  const bytes = body.slice(128, 128 + length * 2);
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return out;
}

/** CCTP domain id for Arc. Source: contract-addresses.md */
export const ARC_CCTP_DOMAIN = 26 as const;

/**
 * Address seeded by Arc Testnet whose value transfers always revert, used to
 * exercise blocklist revert paths.
 * Source: https://docs.arc.io/arc/references/contract-addresses
 */
export const BLOCKLISTED_TEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

/**
 * CtrlArcZ deployment on Arc Testnet.
 * Written by `scripts/sync-deployment.mjs` from the Deploy.s.sol output — never
 * edited by hand. The zero address means "not deployed yet".
 */
export const CTRL_ARCZ_ADDRESS = '0x8dAb7148cdc31DAcad6d7e12161AA3DEDb572Dca' as `0x${string}`;
export const CODE_CLAIM_VERIFIER_ADDRESS =
  '0x2C0f268DE2Aa8BB2ab27F2Ea5Ae8a0f9a0E068c4' as `0x${string}`;

// Payer-side shield (identity-free accounts: no owner stored, co-signer-only pay,
// hashed vault commitment, per-pull cap, EIP-712). Deployed on Arc Testnet.
export const SPEND_POLICY_FACTORY_ADDRESS =
  '0x8AB90Dfe39D9c9bFE8bdDa84545FA734c02442B9' as `0x${string}`;
export const SPEND_POLICY_ACCOUNT_IMPL_ADDRESS =
  '0xa06419b913abA4BFdfEeb9D1A8800DbC2E3A2C11' as `0x${string}`;
export const SHIELD_VAULT_ADDRESS = '0xc8185AF46b882368b771E8E8a1C8abe1C8e4127f' as `0x${string}`;

// ERC-5564 stealth-address announcement registry (schemeId 1). Standalone; does not
// touch the factory/account. Lets a payer publish a box's ephemeral pubkey so only
// their viewing key can rediscover it. Deployed on Arc Testnet.
export const STEALTH_ANNOUNCER_ADDRESS =
  '0x9b9F9F8b98Dd7a74889725e79591B3E69BdC991D' as `0x${string}`;
/** Block the announcer was deployed at. Scanning its events from here (instead of a
 *  fixed lookback from head) keeps discovery to one or two `eth_getLogs` calls. */
export const STEALTH_ANNOUNCER_DEPLOY_BLOCK = 53756547n;

/**
 * Block CtrlArcZ was deployed at. Event queries start here, never from 0: Arc's
 * RPC caps `eth_getLogs` at a 10,000-block range (error -32614), so a full-history
 * scan must be chunked from this block forward. See `getLogsChunked`.
 */
export const CTRL_ARCZ_DEPLOY_BLOCK = 51326557n;

/** Arc RPC hard limit on an `eth_getLogs` block range. */
export const MAX_LOG_RANGE = 10000n;

export const explorerTxUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddressUrl = (address: string) => `${EXPLORER_URL}/address/${address}`;
