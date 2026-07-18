import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Account, Address, Hex, PublicClient, WalletClient } from 'viem';
import { publicClient, walletClientFromAccount } from './clients';

/**
 * Wallet session the screens consume. This is the stable seam: the current
 * implementation is a local testnet key kept in the device Keychain/Keystore
 * (expo-secure-store), which makes the app fully functional (read balances, sign,
 * send) without a wallet app. It will be swapped for Privy, which yields the same
 * shape from either an embedded wallet (email/passkey) or an external wallet over
 * WalletConnect, so screens do not change.
 */
export interface WalletSession {
  address: Address;
  /** A local account (has signMessage/signTypedData), backed by the device key. */
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

interface WalletContextValue {
  session: WalletSession | null;
  loading: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Permanently delete the key from secure storage. */
  wipe: () => Promise<void>;
}

// Device-only so the key cannot ride an encrypted device backup off the phone.
const STORE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const WalletContext = createContext<WalletContextValue | null>(null);
const KEY_ID = 'ctrlarcz.devkey.v1';

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [loading, setLoading] = useState(true);

  const sessionFromKey = (pk: Hex): WalletSession => {
    const account = privateKeyToAccount(pk);
    return {
      address: account.address,
      account,
      publicClient,
      walletClient: walletClientFromAccount(account),
    };
  };

  useEffect(() => {
    (async () => {
      try {
        const pk = (await SecureStore.getItemAsync(KEY_ID)) as Hex | null;
        if (pk) setSession(sessionFromKey(pk));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const connect = async () => {
    let pk = (await SecureStore.getItemAsync(KEY_ID)) as Hex | null;
    if (!pk) {
      pk = generatePrivateKey();
      await SecureStore.setItemAsync(KEY_ID, pk, STORE_OPTS);
    }
    setSession(sessionFromKey(pk));
  };

  const disconnect = async () => {
    setSession(null); // lock the session; the key stays in secure storage
  };

  const wipe = async () => {
    await SecureStore.deleteItemAsync(KEY_ID);
    setSession(null);
  };

  return (
    <WalletContext.Provider value={{ session, loading, connect, disconnect, wipe }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within a WalletProvider');
  return ctx;
}
