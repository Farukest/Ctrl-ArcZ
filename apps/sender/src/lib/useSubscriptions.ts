import { useCallback, useEffect, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import {
  ADDRESSES,
  SPEND_POLICY_FACTORY_ADDRESS,
  spendPolicyFactoryAbi,
  ownerHash as toOwnerHash,
  readAccount,
  getLogsChunked,
  MODE_PULL,
} from '@ctrl-arcz/sdk';

const USDC = ADDRESSES.USDC as Address;
// Bound the one-time discovery scan (the factory is recent; this keeps the initial
// eth_getLogs cheap instead of scanning from an ancient deploy block).
const DISCOVER_LOOKBACK = 120_000n;

export type SubStatus = 'active' | 'completed' | 'cancelled' | 'expired';

export interface Subscription {
  account: Address;
  target: Address;
  salt: Hex;
  cap: bigint;
  perPull: bigint;
  interval: number;
  expiry: number;
  spent: bigint;
  remaining: bigint;
  lastPull: number;
  balance: bigint;
  status: SubStatus;
  nextPullAt: number;
  pullableNow: bigint;
}

function statusOf(s: { balance: bigint; spent: bigint; cap: bigint; expiry: number; now: number }): SubStatus {
  if (s.balance === 0n) return s.spent >= s.cap ? 'completed' : 'cancelled';
  if (s.now > s.expiry) return 'expired';
  return 'active';
}

/**
 * The connected wallet's PULL subscriptions, read from chain. Discovery (the log
 * scan for `AccountCreated(ownerHash)`) runs once on mount and on `reload()`; the
 * periodic poll only re-reads each known box's state + balance, so it never hammers
 * the rate-limited RPC with repeated from-deploy-block scans.
 */
export function useSubscriptions(session: Session | null): {
  subs: Subscription[] | null;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Discovered box addresses (+ their creation salt), independent of poll refreshes.
  const accounts = useRef<Map<string, Hex>>(new Map());

  const refresh = useCallback(async () => {
    if (!session) {
      setSubs(null);
      return;
    }
    const client = getPublicClient();
    const now = Math.floor(Date.now() / 1000);
    const built = await Promise.all(
      [...accounts.current.entries()].map(async ([addrLc, salt]) => {
        const account = addrLc as Address;
        try {
          const [state, balance] = await Promise.all([
            readAccount(client, account),
            client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>,
          ]);
          if (state.mode !== MODE_PULL) return null;
          const cap = state.remaining + state.spent;
          const status = statusOf({ balance, spent: state.spent, cap, expiry: state.expiry, now });
          const nextPullAt = state.lastPull === 0 ? now : state.lastPull + state.interval;
          const headroom = state.remaining < balance ? state.remaining : balance;
          const perPull = state.perPullMax;
          const pullTarget = perPull < headroom ? perPull : headroom;
          const pullableNow = status === 'active' && now >= nextPullAt && pullTarget > 0n ? pullTarget : 0n;
          return {
            account,
            target: state.target,
            salt,
            cap,
            perPull,
            interval: state.interval,
            expiry: state.expiry,
            spent: state.spent,
            remaining: state.remaining,
            lastPull: state.lastPull,
            balance,
            status,
            nextPullAt,
            pullableNow,
          } satisfies Subscription;
        } catch {
          return null;
        }
      }),
    );
    setSubs(built.filter((s): s is Subscription => s !== null));
  }, [session]);

  const discover = useCallback(async () => {
    if (!session) return;
    const client = getPublicClient();
    try {
      const latest = await client.getBlockNumber();
      const fromBlock = latest > DISCOVER_LOOKBACK ? latest - DISCOVER_LOOKBACK : 0n;
      const logs = await getLogsChunked<{ account?: Address; salt?: Hex }>(client, {
        address: SPEND_POLICY_FACTORY_ADDRESS,
        abi: spendPolicyFactoryAbi,
        eventName: 'AccountCreated',
        args: { ownerHash: toOwnerHash(session.address as Address) },
        fromBlock,
      });
      for (const l of logs) {
        const a = l.args.account?.toLowerCase();
        if (a && !accounts.current.has(a)) accounts.current.set(a, (l.args.salt ?? ('0x' as Hex)) as Hex);
      }
    } catch {
      /* keep whatever we have */
    }
  }, [session]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      await discover();
      await refresh();
    } finally {
      setLoading(false);
    }
  }, [discover, refresh]);

  useEffect(() => {
    accounts.current = new Map();
    setSubs(null);
    void reload();
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [session, reload, refresh]);

  return { subs, loading, reload };
}
