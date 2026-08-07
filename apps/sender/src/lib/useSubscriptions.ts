import { useCallback, useEffect, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import {
  ADDRESSES,
  SPEND_POLICY_FACTORY_ADDRESS,
  STEALTH_ANNOUNCER_ADDRESS,
  STEALTH_ANNOUNCER_DEPLOY_BLOCK,
  spendPolicyFactoryAbi,
  ownerHash as toOwnerHash,
  readAccount,
  getLogsChunked,
  discoverStealthBoxes,
  MODE_PULL,
} from '@ctrl-arcz/sdk';
import { getStealthKeys, stealthKeysDeclined, allowStealthPrompt } from './stealthKeys.js';

const USDC = ADDRESSES.USDC as Address;
// Bound the one-time discovery scan (the factory is recent; this keeps the initial
// eth_getLogs cheap instead of scanning from an ancient deploy block).
const DISCOVER_LOOKBACK = 120_000n;

export type SubStatus = 'active' | 'completed' | 'cancelled' | 'expired';

export interface Subscription {
  account: Address;
  target: Address;
  salt: Hex;
  /** Present for stealth boxes: the ephemeral pubkey needed to derive the key that
   *  controls the box's stealth vault (for cancel). Absent for legacy boxes. */
  ephemeralPubKey?: Hex;
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
  /**
   * Discovery order, which is chronological.
   *
   * A box has no creation timestamp anywhere: the account address is derived from a
   * salt, so comparing addresses orders by a hash. "Newest" did exactly that and
   * returned an arbitrary order that looked deliberate. Announcements arrive in log
   * order, so the position they were found in is the one honest ordering available
   * without reading a block per box.
   */
  discoveredAt: number;
}

function statusOf(s: {
  balance: bigint;
  spent: bigint;
  cap: bigint;
  expiry: number;
  now: number;
}): SubStatus {
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
  reload: (expect?: Address) => Promise<void>;
  /** Record a box this browser just created, so it appears immediately. */
  track: (account: Address, ephemeralPubKey?: Hex) => Promise<void>;
  /** True when the wallet refused to derive the viewing key, so the stealth boxes
   *  cannot be found. An empty list would otherwise read as "you have none". */
  stealthLocked: boolean;
  /** Ask for that signature again. Only ever called from a deliberate click. */
  unlockStealth: () => Promise<void>;
} {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [stealthLocked, setStealthLocked] = useState(false);
  const [loading, setLoading] = useState(false);
  // Discovered box addresses -> their creation salt + (for stealth boxes) the
  // ephemeral pubkey that lets us later derive the key controlling the box's vault.
  const accounts = useRef<Map<string, { salt: Hex; ephemeralPubKey?: Hex; order?: number }>>(
    new Map(),
  );

  const refresh = useCallback(async () => {
    if (!session) {
      setSubs(null);
      return;
    }
    const client = getPublicClient();
    const now = Math.floor(Date.now() / 1000);
    const built = await Promise.all(
      [...accounts.current.entries()].map(async ([addrLc, meta]) => {
        const account = addrLc as Address;
        const { salt, ephemeralPubKey, order } = meta;
        try {
          const [state, balance] = await Promise.all([
            readAccount(client, account),
            client.readContract({
              address: USDC,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [account],
            }) as Promise<bigint>,
          ]);
          if (state.mode !== MODE_PULL) return null;
          const cap = state.remaining + state.spent;
          const status = statusOf({ balance, spent: state.spent, cap, expiry: state.expiry, now });
          const nextPullAt = state.lastPull === 0 ? now : state.lastPull + state.interval;
          const headroom = state.remaining < balance ? state.remaining : balance;
          const perPull = state.perPullMax;
          const pullTarget = perPull < headroom ? perPull : headroom;
          const pullableNow =
            status === 'active' && now >= nextPullAt && pullTarget > 0n ? pullTarget : 0n;
          return {
            account,
            target: state.target,
            salt,
            ...(ephemeralPubKey ? { ephemeralPubKey } : {}),
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
            discoveredAt: order ?? 0,
          } satisfies Subscription;
        } catch {
          return null;
        }
      }),
    );
    setSubs(built.filter((s): s is Subscription => s !== null));
  }, [session]);

  // Stealth boxes: owned/vaulted by a fresh stealth address with no link to the
  // wallet. Found by scanning the announcer (from its deploy block, so one or two
  // getLogs calls) with the viewing key. If the user declines to sign, this no-ops
  // and only legacy boxes show. This is the fast path — the demo's boxes are stealth.
  const discoverStealth = useCallback(async () => {
    if (!session) return;
    const client = getPublicClient();
    try {
      const keys = await getStealthKeys(session);
      const found = await discoverStealthBoxes(client, STEALTH_ANNOUNCER_ADDRESS, keys, {
        fromBlock: STEALTH_ANNOUNCER_DEPLOY_BLOCK,
      });
      for (const b of found) {
        const a = b.box.toLowerCase();
        if (!accounts.current.has(a))
          accounts.current.set(a, {
            salt: '0x' as Hex,
            ephemeralPubKey: b.ephemeralPubKey,
            order: accounts.current.size,
          });
      }
    } catch {
      /* no signature / scan failure: legacy-only view */
    }
    // Surface a refusal, so the tab can say the private boxes are hidden rather
    // than quietly showing an empty list that looks like "you have none".
    setStealthLocked(stealthKeysDeclined(session.address));
  }, [session]);

  // Legacy boxes: created with owner = the wallet address (ownerHash = keccak(addr)).
  // Kept so pre-stealth boxes still appear; runs after the stealth scan so it never
  // delays showing the user's (stealth) subscriptions.
  const discoverLegacy = useCallback(async () => {
    if (!session) return;
    const client = getPublicClient();
    try {
      const latest = await client.getBlockNumber().catch(() => 0n);
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
        if (a && !accounts.current.has(a))
          accounts.current.set(a, {
            salt: (l.args.salt ?? ('0x' as Hex)) as Hex,
            order: accounts.current.size,
          });
      }
    } catch {
      /* keep whatever we have */
    }
  }, [session]);

  const reload = useCallback(
    async (expect?: Address) => {
      setLoading(true);
      try {
        // Fast path first: scan the announcer, render the user's stealth boxes, then
        // drop the spinner. The slower legacy scan fills in any older boxes after.
        await discoverStealth();
        await refresh();

        // A box we just created may not be in the log index of whichever RPC this
        // scan landed on, so a single pass can come back without it and the user is
        // told nothing happened. Retry briefly for the address we are expecting.
        for (let i = 0; expect && !accounts.current.has(expect.toLowerCase()) && i < 5; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          await discoverStealth();
          await refresh();
        }
      } finally {
        setLoading(false);
      }
      await discoverLegacy();
      await refresh();
    },
    [discoverStealth, discoverLegacy, refresh],
  );

  useEffect(() => {
    accounts.current = new Map();
    setSubs(null);
    void reload();
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [session, reload, refresh]);

  /**
   * Adopt a box we created ourselves instead of waiting to rediscover it.
   *
   * Discovery works by scanning the announcer's logs, and an RPC's log index lags
   * its chain head by an unbounded amount -- observed at over a minute. So a
   * subscription that was already deployed, funded and announced sat missing from
   * the list that had just created it, with nothing to say it was coming. We know
   * this box's address and its ephemeral key first hand; there is nothing to
   * discover. The scan still runs and is still what finds boxes made elsewhere.
   */
  const track = useCallback(
    async (account: Address, ephemeralPubKey?: Hex) => {
      const a = account.toLowerCase();
      if (!accounts.current.has(a)) {
        accounts.current.set(a, {
          salt: '0x' as Hex,
          ...(ephemeralPubKey ? { ephemeralPubKey } : {}),
          order: accounts.current.size,
        });
      }
      // Read this one box and render it now. Registering it without refreshing
      // still left the caller waiting on the announcer scan that `reload` starts
      // with -- which is the very wait this exists to remove.
      await refresh();
    },
    [refresh],
  );

  /** Ask again after a refusal. The prompt only ever follows a deliberate click. */
  const unlockStealth = useCallback(async () => {
    allowStealthPrompt(session?.address);
    setStealthLocked(false);
    await reload();
  }, [session, reload]);

  return { subs, loading, reload, track, stealthLocked, unlockStealth };
}
