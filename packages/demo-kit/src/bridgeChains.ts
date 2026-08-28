/**
 * Browser-safe bridge shapes: the steps a transfer moves through, and what one
 * looks like when it is over. Deliberately free of any Bridge Kit / Circle import
 * so the client (BridgeTab, the barrel) can use them without pulling the Node-first
 * `@circle-fin/bridge-kit` into the browser graph. The actual `bridgeUsdc` (which
 * imports Bridge Kit) lives in cctp.ts and is reached only server-side via the
 * `./cctp` subpath.
 *
 * There used to be a chain list here too: `BRIDGE_CHAINS`, `GATEWAY_CHAINS`,
 * `GATEWAY_CHAIN_IDS`, `chainsForEngine` and `bridgeChainLabel`. It was a second
 * registry, and a wrong one -- eleven chains where CCTP serves twenty, five where
 * Gateway serves eleven, and ids Circle does not use (`Optimism_Sepolia`,
 * `Polygon_Amoy_Testnet`), so the two entries most likely to be looked up were the
 * two guaranteed to miss. Nothing consumed it but the barrel. Chains now come from
 * `chainCatalog.ts`, which composes the SDK's registry rather than restating it.
 */

export const BRIDGE_STEPS = ['approve', 'burn', 'fetchAttestation', 'mint'] as const;
export type BridgeStepName = (typeof BRIDGE_STEPS)[number];

/** Steps of a Circle Gateway instant transfer (deposit once, then instant spend). */
export const GATEWAY_STEPS = ['deposit', 'sign', 'attestation', 'mint'] as const;
export type GatewayStepName = (typeof GATEWAY_STEPS)[number];

/** How the cross-chain move is performed. */
export type BridgeEngine = 'cctp' | 'gateway';

export interface BridgeStep {
  name: string;
  state: string;
  txHash?: string;
  explorerUrl?: string;
  /** Why this step failed, as a short line. Without it a failed bridge is a red
   *  square with nothing to act on, for the user and in the server log alike. */
  error?: string;
}
export interface BridgeOutcome {
  state: string;
  amount: string;
  steps: BridgeStep[];
}

