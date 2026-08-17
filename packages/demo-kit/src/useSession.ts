import { useCallback, useEffect, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { ARC_TESTNET_CHAIN_ID, type CctpChainName } from '@ctrl-arcz/sdk';
import { useT } from './i18n/context.js';
import { hasWallet, injectedSession, switchWalletTo, watchWallet, type Session } from './session.js';
import { readWalletUsdc } from './walletUsdc.js';

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
  /**
   * The chain that balance is on, which is the chain the wallet is on.
   *
   * Undefined means the wallet is on a network we have no USDC address for, so
   * there is no figure to wait for. The bar renders the two differently: a balance
   * still being read shimmers, one that is never coming holds still.
   */
  balanceChain: CctpChainName | undefined;
  /**
   * Why `balanceRaw` is null, when it is.
   *
   * Null meant two different things and the bar could only render one of them. It
   * is "the first read has not landed" for the moment after connecting, and "there
   * is nothing to land" on a chain with no USDC entry, or after a read that failed.
   * Shown the same way, the second became a placeholder shimmering forever for a
   * figure that was never coming.
   */
  balanceMissing: 'loading' | 'unavailable';
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
  const [balanceChain, setBalanceChain] = useState<CctpChainName | undefined>(undefined);
  const [balanceMissing, setBalanceMissing] = useState<'loading' | 'unavailable'>('loading');
  const [connecting, setConnecting] = useState(false);
  // Start "reconnecting" synchronously when a prior connection is remembered, so
  // the very first render already knows to show a placeholder (no connect flash).
  const [reconnecting, setReconnecting] = useState(() => remember.get());
  const [error, setError] = useState<string | null>(null);
  const [walletDetected, setWalletDetected] = useState(false);
  const t = useT();

  /**
   * The balance, on whichever network the wallet is on.
   *
   * It used to name Arc's USDC and use Arc's RPC unconditionally, so a wallet on
   * Ethereum Sepolia was shown an Arc figure in the largest number on the page,
   * directly beneath a header chip that correctly said Ethereum Sepolia. Two
   * controls, one wallet, two different answers about where it was.
   *
   * A chain with no USDC entry leaves both figures null rather than zero. Nothing
   * was read, so nothing is claimed.
   */
  const refreshBalance = useCallback(async () => {
    if (!session) return;
    const { chain, balance: raw } = await readWalletUsdc(
      session.chainId,
      session.address as Address,
    );
    setBalanceChain(chain);
    setBalanceRaw(raw);
    setBalance(raw === null ? '0' : formatUnits(raw, 6));
    // A read that came back empty is a read that happened. Leaving this on
    // `loading` is what kept the placeholder moving on a chain whose USDC could
    // not be reached.
    setBalanceMissing(raw === null ? 'unavailable' : 'loading');
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
        await switchWalletTo(chainId, label);
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
  // different balance, and so does a different chain: both were true of the figure
  // on screen, and holding it until the next read lands shows one account's money
  // under another account's address, or one network's under another network's name.
  // Null means unknown, which every consumer renders as a placeholder, not as zero.
  useEffect(() => {
    setBalance('0');
    setBalanceRaw(null);
    setBalanceChain(undefined);
    setBalanceMissing('loading');
  }, [session?.address, session?.chainId]);

  useEffect(() => {
    void refreshBalance();
    if (!session) return;
    // Slower off Arc. Arc is read through our own RPCs and costs the wallet
    // nothing; every other chain is reachable only through the wallet's provider,
    // and MetaMask rate-limits a site by how many requests it makes there -- a
    // budget the transaction being signed needs more than this figure does.
    const every = session.chainId === ARC_TESTNET_CHAIN_ID ? 10_000 : 20_000;
    const timer = setInterval(() => void refreshBalance(), every);
    return () => clearInterval(timer);
  }, [session, refreshBalance]);

  return {
    session,
    balance,
    balanceRaw,
    balanceChain,
    balanceMissing,
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
