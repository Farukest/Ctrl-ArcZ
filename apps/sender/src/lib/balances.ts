/**
 * The app's balances, each held once and shared by every tab that shows it.
 *
 * Two kinds, one store shape (see {@link createBalanceStore}):
 *  - Gateway: Circle's unified USDC balance per chain, keyed by depositor.
 *  - Wallet USDC: the wallet's own USDC on a given chain, keyed by chain+address.
 *
 * A tab reads these through the hooks below instead of fetching on mount, so
 * switching tabs shows the last-known figure at once and refreshes behind it, and
 * anything that moves money calls {@link bumpBalances} to refresh what is on
 * screen from this one source.
 */
import type { Address } from 'viem';
import { readUsdcOn } from '@ctrl-arcz/demo-kit';
import { type CctpChainName, type GatewayChain, gatewayBalance } from '@ctrl-arcz/sdk';
import { createBalanceStore, useBalance, type Resolved } from './balanceStore.js';

export type GatewayByChain = Partial<Record<GatewayChain, bigint>>;

/* Gateway (Circle unified balance) ----------------------------------------- */

const gatewayStore = createBalanceStore<{ depositor: Address }, GatewayByChain>({
  keyOf: (a) => a.depositor.toLowerCase(),
  read: async (a) => (await gatewayBalance({ depositor: a.depositor })).byChain,
});

/** The shared Gateway balances for a depositor: `{ value: byChain, resolved }`. */
export function useGatewayBalances(depositor?: Address): Resolved<GatewayByChain> {
  return useBalance(gatewayStore, depositor ? { depositor } : null);
}

/* Wallet USDC (the wallet's own holding on a chain) ------------------------- */

const walletUsdcStore = createBalanceStore<
  { chain: CctpChainName; connectedChainId: number | undefined; address: Address },
  bigint | null
>({
  // Keyed by chain and address, not the connected network: which network the
  // wallet is on decides whether the read succeeds, not which balance it is.
  keyOf: (a) => `${a.chain}:${a.address.toLowerCase()}`,
  read: (a) => readUsdcOn(a.chain, a.connectedChainId, a.address),
});

/**
 * The wallet's USDC on `chain`. A resolved `null` means "on another network, so it
 * could not be read", which the caller shows as a note rather than a figure.
 */
export function useWalletUsdc(
  chain: CctpChainName | undefined,
  connectedChainId: number | undefined,
  address?: Address,
): Resolved<bigint | null> {
  return useBalance(
    walletUsdcStore,
    chain && address ? { chain, connectedChainId, address } : null,
  );
}
