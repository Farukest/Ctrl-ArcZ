/**
 * The two reads the activity screen makes for itself.
 *
 * Bridge runs and subscription fundings already arrive live through
 * `useActivity`, which is written to the store as they happen. These two are not
 * ours to be told about: a protected transfer's status belongs to the contract,
 * and the token history belongs to the explorer, so both are polled.
 *
 * Both also listen for `storage`, which fires in the other tabs of this site. A
 * send made in one tab appears in the list open in another without either being
 * reloaded, which is the whole point of a history that is worth leaving open.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { Session } from '@ctrl-arcz/demo-kit';
import { getCleanHistory, getTransfer, type CleanHistory } from '@ctrl-arcz/sdk';
import { loadTransfers } from '../store.js';
import type { SentRow } from './activityEntries.js';

/** The chain moves on its own; this is how often we ask it what changed. */
const SENT_POLL_MS = 8_000;
/**
 * The explorer is a slower, heavier read than the contract, and its answers
 * change only when a transaction lands. Half a minute is often enough to catch
 * one while the tab is open and rare enough not to spend somebody's rate limit
 * on a screen they left open.
 */
const HISTORY_POLL_MS = 30_000;

export function useSentTransfers(session: Session): {
  rows: SentRow[] | null;
  reload: () => Promise<void>;
} {
  const [rows, setRows] = useState<SentRow[] | null>(null);

  const reload = useCallback(async () => {
    const stored = loadTransfers(session.address as Address);
    const resolved = await Promise.all(
      stored.map(async (s) => ({
        stored: s,
        // A transfer the chain cannot answer for is shown as unreadable rather
        // than dropped: it is in this browser's store because this browser sent
        // it, and a failed read is our problem, not evidence it never happened.
        chain: await getTransfer(session.clients, BigInt(s.transferId)).catch(() => null),
      })),
    );
    setRows(resolved);
  }, [session]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), SENT_POLL_MS);
    const onStorage = () => void reload();
    window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, [reload]);

  return { rows, reload };
}

export function useTokenHistory(session: Session): {
  history: CleanHistory | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [history, setHistory] = useState<CleanHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setHistory(await getCleanHistory(session.address as Address));
      setError(null);
    } catch (e) {
      // Only the first failure is worth reporting. A later one leaves the last
      // good answer on screen, which beats replacing a working list with a
      // message about a poll nobody asked for.
      setHistory((prev) => {
        if (prev === null) setError(e instanceof Error ? e.message : String(e));
        return prev;
      });
    }
  }, [session.address]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), HISTORY_POLL_MS);
    // Coming back to the tab is the moment somebody most wants it current, and
    // it costs one read rather than a faster poll for everyone who stayed.
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [reload]);

  return { history, error, reload };
}
