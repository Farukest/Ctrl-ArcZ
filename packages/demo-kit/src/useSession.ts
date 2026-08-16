import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, formatUnits, type Address } from 'viem';
import { ADDRESSES, ARC_TESTNET_CHAIN_ID } from '@ctrl-arcz/sdk';
import { useT } from './i18n/context.js';
import {
  getPublicClient,
  hasWallet,
  injectedSession,
  switchToArc,
  switchWalletChain,
  watchWallet,
  type Session,
} from './session.js';

export interface SessionState {
  session: Session | null;
  balance: string;
  /**
   * The same figure in USDC subunits, for arithmetic.
   *
   * `balance` is formatted for reading and every caller that needed to compare or
   * subtract was parsing that string back, which is a lossy round trip through a
   * display format. Both come from the one read, so they cannot disagree.
   */
  balanceRaw: bigint | null;
  connecting: boolean;
  /** True during the silent reconnect on first load — show a placeholder, not the
   *  Connect prompt, so a remembered wallet never flashes "connect" before it
   *  reappears. */
  reconnecting: boolean;
  error: string | null;
  walletDetected: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Back to Arc. Shorthand for `switchTo(ARC_TESTNET_CHAIN_ID)`. */
  switchChain: () => Promise<void>;
  /**
   * Move the wallet to `chainId`.
   *
   * Arc goes through `switchToArc`, which may add the network, because we operate
   * its endpoints. Every other chain must already be in the wallet: adding one
   * means naming an RPC the user then trusts with everything they do there, and
   * that is not a choice to make on their behalf.
   */
  switchTo: (chainId: number, label?: string) => Promise<void>;
  refreshBalance: () => Promise<void>;
}

// Remembers that the user connected, so a page reload silently reconnects
// (a professional wallet UX). Cleared on explicit Disconnect so that choice
// also survives a reload.
const REMEMBER_KEY = 'ctrl-arcz:wallet-connected';
const remember = {
  get: () => {
    try {
      return localStorage.getItem(REMEMBER_KEY) === '1';
    } catch {
      return false;
    }
  },
  set: (on: boolean) => {
    try {
      if (on) localStorage.setItem(REMEMBER_KEY, '1');
      else localStorage.removeItem(REMEMBER_KEY);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Wallet-connection state for the demo apps — the reference implementation an
 * integrator can lift. Uses the real injected EIP-1193 wallet (in tests, a
 * local-key provider is installed on `window.ethereum`, so the same flow runs
 * headlessly). Persists the connection across reloads and tracks account/chain
 * changes, without ever silently re-prompting.
 */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null>(null);
  const [balance, setBalance] = useState('0');
  const [balanceRaw, setBalanceRaw] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Start "reconnecting" synchronously when a prior connection is remembered, so
  // the very first render already knows to show a placeholder (no connect flash).
  const [reconnecting, setReconnecting] = useState(() => remember.get());
  const [error, setError] = useState<string | null>(null);
  const [walletDetected, setWalletDetected] = useState(false);
  const t = useT();

  const refreshBalance = useCallback(async () => {
    if (!session) return;
    const raw = await getPublicClient().readContract({
      address: ADDRESSES.USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [session.address as Address],
    });
    setBalance(formatUnits(raw, 6));
    setBalanceRaw(raw);
  }, [session]);

  // Silent reconnect: no prompt. Used on mount (reload persistence) and on
  // wallet account/chain changes. Clears the session if authorization is gone.
  const reconnect = useCallback(async () => {
    if (!hasWallet()) return;
    try {
      const s = await injectedSession({ silent: true });
      setSession(s);
      if (!s) remember.set(false);
    } catch {
      setSession(null);
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const s = await injectedSession();
      if (s) {
        setSession(s);
        remember.set(true);
      }
    } catch (e) {
      const code = (e as { code?: number }).code;
      setError(
        code === 4001 ? t('common.connectRejected') : e instanceof Error ? e.message : String(e),
      );
    } finally {
      setConnecting(false);
    }
  }, [t]);

  const disconnect = useCallback(() => {
    remember.set(false);
    setSession(null);
    setBalance('0');
  }, []);

  const switchTo = useCallback(
    async (chainId: number, label?: string) => {
      setError(null);
      try {
        if (chainId === ARC_TESTNET_CHAIN_ID) await switchToArc();
        else await switchWalletChain(chainId, label ?? `chain ${chainId}`);
        // The wallet emits `chainChanged` and `watchWallet` reconnects on its own,
        // but not every provider does, and a chip that still reads the old network
        // after a successful switch is worse than one extra read.
        await reconnect();
      } catch (e) {
        const code = (e as { code?: number }).code;
        setError(
          code === 4001 ? t('common.switchRejected') : e instanceof Error ? e.message : String(e),
        );
      }
    },
    [reconnect, t],
  );

  const switchChain = useCallback(() => switchTo(ARC_TESTNET_CHAIN_ID), [switchTo]);

  // On mount: detect the wallet (deferred so an injected test provider registers
  // first) and silently reconnect if the user was connected before the reload.
  useEffect(() => {
    const detected = hasWallet();
    setWalletDetected(detected);
    if (remember.get() && detected) {
      void reconnect().finally(() => setReconnecting(false));
    } else {
      setReconnecting(false);
    }
  }, [reconnect]);

  // Track account/chain changes (and wallet-side disconnects) with a silent
  // reconnect, so the UI never shows a stale account and never re-prompts.
  useEffect(() => {
    if (!session) return;
    return watchWallet(() => void reconnect());
  }, [session, reconnect]);

  // Forget the old number before asking for the new one. A different wallet has a
  // different balance, and holding the previous one on screen until the read lands
  // shows one account's money under another account's address. Null means unknown,
  // which is what every consumer renders as a placeholder rather than as zero.
  useEffect(() => {
    setBalance('0');
    setBalanceRaw(null);
  }, [session?.address]);

  useEffect(() => {
    void refreshBalance();
    if (!session) return;
    const timer = setInterval(() => void refreshBalance(), 10_000);
    return () => clearInterval(timer);
  }, [session, refreshBalance]);

  return {
    session,
    balance,
    balanceRaw,
    connecting,
    reconnecting,
    error,
    walletDetected,
    connect,
    disconnect,
    switchChain,
    switchTo,
    refreshBalance,
  };
}
