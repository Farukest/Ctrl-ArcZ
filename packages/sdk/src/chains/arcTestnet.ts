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
export const WS_URL = 'wss://rpc.testnet.arc.network' as const;
export const EXPLORER_URL = 'https://testnet.arcscan.app' as const;

/**
 * Blockscout-compatible REST API exposed by ArcScan. The schema is not part of
 * the Arc docs; it was verified against the live API.
 */
export const EXPLORER_API_URL = `${EXPLORER_URL}/api/v2` as const;

export const FAUCET_URL = 'https://faucet.circle.com' as const;
