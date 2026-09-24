import { defineChain } from 'viem';
import { arc as viemArc } from 'viem/chains';

/**
 * Arc mainnet: the network facts, nothing of ours.
 *
 * Kept apart from `arcTestnet.ts` rather than folded into it, because almost every
 * number here differs from its testnet twin while the names do not, and a table
 * that holds both invites reading the wrong column. Our own contracts on this chain
 * live in `deployments.ts`, like every other chain's.
 *
 * Sources, read 2026-09-24 and each checked against the chain the same day:
 *   - https://docs.arc.io/arc/references/rpc-endpoints
 *   - https://docs.arc.io/arc/references/contract-addresses
 *   - https://docs.arc.io/arc/references/connect-to-arc
 */

export const ARC_MAINNET_CHAIN_ID = 5042 as const;

/** Circle's own endpoint. Answered without credentials on 2026-09-24. */
export const ARC_MAINNET_RPC_URL = 'https://rpc.mainnet.arc.io' as const;

/**
 * Read endpoints, best first.
 *
 * Arc's docs list four public mainnet URLs; three are here. dRPC's free tier
 * refused every `eth_getLogs` on 2026-09-24, whatever the range, and the event
 * indexers are most of what this list is for. Alchemy needs a key, and a key does
 * not go in a list the browser reads. The three that remain each answered a
 * 10,000-block address-filtered `eth_getLogs`, the chunk size `maxLogRange` uses.
 */
export const ARC_MAINNET_RPC_URLS = [
  ARC_MAINNET_RPC_URL,
  'https://rpc.quicknode.mainnet.arc.io',
  'https://rpc.blockdaemon.mainnet.arc.io',
] as const;

/**
 * The explorer's front page, for links a person follows.
 *
 * Its API is not usable: on 2026-09-24 every `/api` path answered 403 behind a
 * Cloudflare challenge, and the docs call the explorer permissioned. So nothing in
 * this SDK reads history from it; see `alchemyNetwork` in the deployment.
 */
export const ARC_MAINNET_EXPLORER_URL = 'https://explorer.arc.io' as const;

/** viem ships `arc` with no endpoint at all, so it is completed here. */
export const arcMainnet = defineChain({
  ...viemArc,
  rpcUrls: { default: { http: [...ARC_MAINNET_RPC_URLS] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: ARC_MAINNET_EXPLORER_URL } },
  // Checked to have code on 2026-09-24. viem batches reads through it.
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 0 },
  },
});

/**
 * Arc mainnet addresses that are not ours.
 *
 * Several are the same as testnet (USDC, Memo, Multicall3From, Permit2, Multicall3,
 * the CREATE2 factory) and several are not (EURC, cirBTC, USYC, CCTP, Gateway,
 * StableFX), which is exactly why this is a second table and not a flag on the
 * first. CCTP and Gateway are not repeated here: they travel with Circle's chain
 * table (`circleChains.generated.ts`).
 */
export const ARC_MAINNET_ADDRESSES = {
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
  CIRBTC: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
  USYC: '0x8a5D989Bbb96929F689B0200f435f53dA42bF490',
  MEMO: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
  MULTICALL3_FROM: '0x522fAf9A91c41c443c66765030741e4AaCe147D0',
  MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  CREATE2_FACTORY: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  FX_ESCROW: '0xe2E5F173576B513d994073CCbDaCBE027d43DFe6',
} as const satisfies Record<string, `0x${string}`>;

/** Arc testnet and Arc mainnet: the two chains that bill gas in USDC. */
export const ARC_CHAIN_IDS: readonly number[] = [5042002, ARC_MAINNET_CHAIN_ID];

/** Whether a chain is Arc, on either network. */
export function isArcChain(chainId: number | undefined): boolean {
  return chainId !== undefined && ARC_CHAIN_IDS.includes(chainId);
}
