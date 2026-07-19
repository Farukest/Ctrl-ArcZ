import { useAccount, useDisconnect, useWalletClient } from 'wagmi';
import { useAppKit } from '@reown/appkit-wagmi-react-native';
import type { Address, PublicClient, WalletClient } from 'viem';
import { publicClient } from './clients';

/**
 * Wallet session the screens consume, backed by the user's OWN connected wallet
 * (WalletConnect via wagmi/AppKit). There is NO local key: the private key stays in
 * the user's wallet app (MetaMask/Rabby/...), which prompts for its own biometric or
 * PIN on every signature. `walletClient` routes writes/signs to that wallet;
 * `publicClient` is our own rate-limited read client.
 */
export interface WalletSession {
  address: Address;
  /** Signs/broadcasts through the connected external wallet. wagmi returns a viem
   *  WalletClient at runtime; its inferred type is loose, so we assert viem's. */
  walletClient: WalletClient;
  publicClient: PublicClient;
}

export interface WalletState {
  session: WalletSession | null;
  loading: boolean;
  /** Open the wallet-picker modal (MetaMask, Rabby, Trust, ...). */
  connect: () => void;
  disconnect: () => void;
}

export function useWallet(): WalletState {
  const { address, isConnected } = useAccount();
  const { data: walletClient, isLoading } = useWalletClient();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();

  const wc = walletClient as unknown as WalletClient | undefined;
  const session: WalletSession | null =
    isConnected && address && wc ? { address, walletClient: wc, publicClient } : null;

  return {
    session,
    loading: isLoading,
    connect: () => {
      void open();
    },
    disconnect: () => {
      disconnect();
    },
  };
}
