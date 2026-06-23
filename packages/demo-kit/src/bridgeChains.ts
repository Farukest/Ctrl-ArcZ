/**
 * Browser-safe CCTP constants and types. Deliberately free of any Bridge Kit /
 * Circle import so the client (BridgeTab, the barrel) can use the chain list and
 * types without pulling the Node-first `@circle-fin/bridge-kit` into the browser
 * graph. The actual `bridgeUsdc` (which imports Bridge Kit) lives in cctp.ts and is
 * reached only server-side via the `./cctp` subpath.
 */

/** Chain identifiers Bridge Kit uses (string enum values, not chain ids). */
export type BridgeChainName =
  | 'Arc_Testnet'
  | 'Ethereum_Sepolia'
  | 'Base_Sepolia'
  | 'Arbitrum_Sepolia'
  | 'Optimism_Sepolia'
  | 'Avalanche_Fuji'
  | 'Polygon_Amoy_Testnet'
  | 'Unichain_Sepolia'
  | 'Linea_Sepolia'
  | 'Sonic_Testnet'
  | 'World_Chain_Sepolia';

export const BRIDGE_STEPS = ['approve', 'burn', 'fetchAttestation', 'mint'] as const;
export type BridgeStepName = (typeof BRIDGE_STEPS)[number];

export interface BridgeStep {
  name: string;
  state: string;
  txHash?: string;
  explorerUrl?: string;
}
export interface BridgeOutcome {
  state: string;
  amount: string;
  steps: BridgeStep[];
}

/**
 * The CCTP v2 testnets the demo lets you bridge between. Any pair works as a
 * From/To; the source needs USDC (and gas, except on USDC-gas chains like Arc).
 * All are EVM, so the viem private-key adapter can sign on either side.
 */
export const BRIDGE_CHAINS: { id: BridgeChainName; label: string }[] = [
  { id: 'Arc_Testnet', label: 'Arc Testnet' },
  { id: 'Ethereum_Sepolia', label: 'Ethereum Sepolia' },
  { id: 'Base_Sepolia', label: 'Base Sepolia' },
  { id: 'Arbitrum_Sepolia', label: 'Arbitrum Sepolia' },
  { id: 'Optimism_Sepolia', label: 'Optimism Sepolia' },
  { id: 'Avalanche_Fuji', label: 'Avalanche Fuji' },
  { id: 'Polygon_Amoy_Testnet', label: 'Polygon Amoy' },
  { id: 'Unichain_Sepolia', label: 'Unichain Sepolia' },
  { id: 'Linea_Sepolia', label: 'Linea Sepolia' },
  { id: 'Sonic_Testnet', label: 'Sonic Testnet' },
  { id: 'World_Chain_Sepolia', label: 'World Chain Sepolia' },
];

export function bridgeChainLabel(id: string): string {
  return BRIDGE_CHAINS.find((c) => c.id === id)?.label ?? id;
}
