import { useCallback, useEffect, useRef, useState } from 'react';
import { cctpChainByChainId, type CctpChainName } from '@ctrl-arcz/sdk';

/**
 * Keeping a chain control and the wallet pointed at the same network.
 *
 * Every control on these screens that names a chain -- the bridge's From, the
 * Gateway funding box's source, anything added next to them -- decides where a
 * transaction is going to be signed. Each of them used to open on a hardcoded
 * `Arc_Testnet` and stay there: a wallet connected to Ethereum Sepolia met a form
 * that said Arc, read Arc's balances, and explained in a note underneath that the
 * wallet was somewhere else. The information to be right was on screen the whole
 * time, one control away, in the header.
 *
 * So the binding goes both ways, and this is the one place it is written down.
 *
 * Wallet to control: the wallet's network is the fact, and a control that serves
 * that network shows it. Not once at mount -- on every change, because the user can
 * switch networks in MetaMask itself, and a control that only reads the chain when
 * it is created is a control that is stale for the rest of the session.
 *
 * Control to wallet: choosing a source chain is choosing where the transaction
 * goes, so the wallet follows. This replaces a pattern where picking a chain armed
 * a second button whose whole job was to say "now move your wallet there" -- the
 * user had already said it.
 *
 * What deliberately does not use this: the bridge's destination (nothing is signed
 * there, so the wallet has no business following it) and the header's own network
 * chip (it is the wallet, not a view of it).
 */

/** A chain control's world: which chains it offers, and their ids. */
export interface ChainOptionSet<T extends string> {
  options: readonly T[];
  chainIdOf: (option: T) => number;
}

/**
 * Where a control should stand, given the wallet and where it stands now.
 *
 * Pure, and separate from the hook, because this is the rule and the hook is only
 * the wiring. The order matters:
 *
 * 1. The wallet's chain, when this control serves it. The wallet is the fact.
 * 2. Otherwise whatever the control already showed, if it is still on offer -- a
 *    wallet on a chain this control does not serve is not a reason to throw away a
 *    deliberate choice.
 * 3. Otherwise the fallback, which is where the app's contracts live.
 */
export function chainForWallet<T extends string>(
  set: ChainOptionSet<T>,
  walletChainId: number | undefined,
  current: T | undefined,
  fallback: T,
): T {
  if (walletChainId !== undefined) {
    const onWallet = set.options.find((o) => set.chainIdOf(o) === walletChainId);
    if (onWallet) return onWallet;
  }
  if (current !== undefined && set.options.includes(current)) return current;
  return fallback;
}

/**
 * The other end of a bridge route.
 *
 * Not bound to the wallet, and the only chain control here that is not: the
 * destination is where money arrives, and nothing is signed there. Binding it would
 * mean a route that can only ever end where it started.
 *
 * The default is home. This app's contracts, its protected transfers and its
 * subscription boxes are all on Arc, so bringing money to Arc is what someone
 * opening a bridge is nearly always doing -- and when the money is already leaving
 * Arc, a route from a chain to itself is not a bridge at all, so it steps aside to
 * the first other chain on offer.
 *
 * An explicit choice wins over all of that, and keeps winning until it becomes
 * impossible: switching to the Gateway engine narrows the list, and a destination
 * that is no longer on it has to give way to something that is.
 */
export function destinationChain<T extends string>(
  options: readonly T[],
  from: T,
  chosen: T | null,
  home: T,
): T {
  if (chosen !== null && chosen !== from && options.includes(chosen)) return chosen;
  if (home !== from && options.includes(home)) return home;
  return options.find((o) => o !== from) ?? from;
}

export interface WalletChainBinding<T extends string> {
  /** The chain this control is showing. */
  value: T;
  /** Choose a chain here, and take the wallet with you. */
  select: (next: T) => void;
  /** True when the wallet is actually on `value`. False means the user picked a
   *  chain and the wallet has not arrived -- usually a rejected switch. */
  walletHere: boolean;
  /** Set while the wallet is being asked to move. */
  switching: boolean;
}

export interface UseWalletChainOptions<T extends string> extends ChainOptionSet<T> {
  /** The wallet's chain, from the session. */
  walletChainId: number | undefined;
  /** Where to stand when the wallet is somewhere this control does not serve. */
  fallback: T;
  /**
   * Move the wallet. Omit for a control that only picks a chain to read from.
   *
   * A rejection is not an error here: the user was asked to move and said no, the
   * control keeps their choice, and the screen's own switch button is still there.
   */
  switchWallet?: (chainId: number, option: T) => Promise<void>;
  /**
   * The value changed, for any reason -- picked here, or changed in the wallet.
   *
   * This is where a caller forgets what it read for the old chain. Every balance,
   * fee and quote on these screens is about one particular network, and left in
   * place across a change they do not go missing, they go wrong.
   */
  onChange?: (next: T, previous: T) => void;
}

/**
 * A chain control bound to the wallet in both directions.
 *
 * @example
 * const source = useWalletChain({
 *   options: GATEWAY_CHAIN_NAMES,
 *   chainIdOf: (n) => CCTP_CHAINS[n].chainId,
 *   walletChainId: session.chainId,
 *   fallback: 'Arc_Testnet',
 *   switchWallet: (id, name) => switchWalletTo(id, chainLabel(name)),
 *   onChange: forgetSourceReads,
 * });
 */
export function useWalletChain<T extends string>({
  options,
  chainIdOf,
  walletChainId,
  fallback,
  switchWallet,
  onChange,
}: UseWalletChainOptions<T>): WalletChainBinding<T> {
  const [value, setValue] = useState<T>(() =>
    chainForWallet({ options, chainIdOf }, walletChainId, undefined, fallback),
  );
  const [switching, setSwitching] = useState(false);

  // Held in refs so a caller can pass inline arrow functions -- which every one of
  // them does -- without re-running the effect below on every render.
  const notify = useRef(onChange);
  notify.current = onChange;
  const chainId = useRef(chainIdOf);
  chainId.current = chainIdOf;
  // The value the effect and the callback below reason about. `onChange` is a side
  // effect and must not run inside a state updater: React invokes those twice in
  // development and may replay them, so a caller's cache would be cleared for a
  // change that had not happened.
  const shown = useRef(value);
  shown.current = value;

  const move = useCallback((next: T) => {
    const previous = shown.current;
    if (next === previous) return false;
    shown.current = next;
    setValue(next);
    notify.current?.(next, previous);
    return true;
  }, []);

  /**
   * Keyed on the option list's contents, not its identity.
   *
   * Callers build these arrays inline, so a new array arrives every render and an
   * effect watching the reference alone would run forever.
   */
  const optionKey = options.join(',');

  // The wallet moved, so the control does. This is the whole of "event-driven":
  // `watchWallet` turns MetaMask's `chainChanged` into a new `session.chainId`,
  // which lands here, and every control bound this way follows in the same tick.
  useEffect(() => {
    move(
      chainForWallet({ options, chainIdOf: chainId.current }, walletChainId, shown.current, fallback),
    );
    // `optionKey` rather than `options`: the array is rebuilt every render, so a
    // dependency on its identity would re-run this forever. Its contents are what
    // this actually depends on, and that is what the key holds.
  }, [walletChainId, optionKey, fallback, move]);

  const select = useCallback(
    (next: T) => {
      if (!move(next) || !switchWallet) return;
      const id = chainId.current(next);
      if (id === walletChainId) return;
      setSwitching(true);
      // A rejected switch leaves the control where the user put it. They asked for
      // this chain and then declined to move; undoing their choice would be a third
      // opinion neither of them expressed. Reporting it is the caller's -- it owns
      // the toast -- and the catch here only stops a rejection from escaping as an
      // unhandled one if the caller forgets.
      void Promise.resolve(switchWallet(id, next))
        .catch(() => {})
        .finally(() => setSwitching(false));
    },
    [move, switchWallet, walletChainId],
  );

  return {
    value,
    select,
    walletHere: walletChainId !== undefined && chainIdOf(value) === walletChainId,
    switching,
  };
}

/**
 * The CCTP chain the wallet is on, or undefined on a network we have no entry for.
 *
 * A thin re-export so screens ask the question in one vocabulary rather than
 * importing the SDK's table and the session's number and joining them by hand.
 */
export function walletChainName(walletChainId: number | undefined): CctpChainName | undefined {
  return cctpChainByChainId(walletChainId);
}
