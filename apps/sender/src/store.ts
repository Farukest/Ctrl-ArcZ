/**
 * Remembers the transfers this browser created, so the "active transfers" tab can
 * list them and show their claim codes. The chain is the source of truth for
 * status; this only records which ids belong to this sender and the code we minted
 * (a sender legitimately holds the code to share it with the recipient).
 */
import type { Address, Hex } from 'viem';
import type { BridgeEngine, FailureCode } from '@ctrl-arcz/demo-kit';

export interface StoredTransfer {
  transferId: string;
  to: Address;
  amount: string;
  /** The claim secret. Held in memory for this session only, never written to disk. */
  secret: string;
  txHash: Hex;
  createdAt: number;
}

const key = (sender: Address) => `ctrl-arcz:sender:${sender.toLowerCase()}`;

/**
 * The claim secret carries all 80 bits that gate a claim, so it is NEVER written to
 * localStorage: on disk it is a credential that any future script-injection on this
 * origin could exfiltrate to settle every outstanding transfer. It lives in memory
 * for this session only, enough for the active-transfers tab to show a secret you
 * just minted, gone on refresh. Hand it over when you send.
 */
const sessionSecrets = new Map<string, string>();

/**
 * One record per key, rather than one array under one key.
 *
 * An array is read, changed and written back, and between the read and the write
 * another tab can do the same thing. Measured on two real tabs: both read an empty
 * list, both added their own transfer, and the second write erased the first --
 * not a stale row, a receipt for money that had moved, gone. There is no lock
 * across tabs to take, and re-reading just before writing only narrows the window.
 *
 * Two tabs writing two records now touch two different keys and cannot lose each
 * other's work. The cost is a scan to read them back, over a list capped at fifty.
 */
const CAP = 50;

function scan<T>(prefix: string): { key: string; value: T }[] {
  const out: { key: string; value: T }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        out.push({ key: k, value: JSON.parse(raw) as T });
      } catch {
        // One unreadable record is not a reason to lose the rest of them.
      }
    }
  } catch {
    // Private mode or storage disabled: an empty history, not a crash.
  }
  return out;
}

/** Drop the oldest beyond the cap, so a long-lived browser does not grow forever. */
function prune(sortedNewestFirst: { key: string }[]): void {
  for (const extra of sortedNewestFirst.slice(CAP)) {
    try {
      localStorage.removeItem(extra.key);
    } catch {
      /* see above */
    }
  }
}

const transferPrefix = (sender: Address) => `${key(sender)}:`;

/**
 * Records written before the split, moved to their own keys once.
 *
 * Deleted only after every row has been written out, so an interruption halfway
 * leaves the old array in place and the next load tries again.
 */
function migrateArray<T>(arrayKey: string, prefix: string, idOf: (row: T) => string): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(arrayKey);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const rows = JSON.parse(raw) as T[];
    for (const row of rows) localStorage.setItem(prefix + idOf(row), JSON.stringify(row));
    localStorage.removeItem(arrayKey);
  } catch {
    /* a corrupt array is left alone rather than half-migrated */
  }
}

export function loadTransfers(sender: Address): StoredTransfer[] {
  migrateArray<StoredTransfer>(key(sender), transferPrefix(sender), (t) => t.transferId);
  const rows = scan<StoredTransfer>(transferPrefix(sender)).sort(
    (a, b) => (b.value.createdAt ?? 0) - (a.value.createdAt ?? 0),
  );
  prune(rows);
  // Re-attach any secret we still hold in memory for this session.
  return rows
    .slice(0, CAP)
    .map(({ value }) => ({ ...value, secret: sessionSecrets.get(value.transferId) ?? '' }));
}

export function saveTransfer(sender: Address, transfer: StoredTransfer): void {
  if (transfer.secret) sessionSecrets.set(transfer.transferId, transfer.secret);
  // Everything EXCEPT the secret.
  const { secret: _secret, ...persistable } = transfer;
  try {
    localStorage.setItem(transferPrefix(sender) + transfer.transferId, JSON.stringify(persistable));
  } catch {
    /* private mode or a full quota; the transfer itself is unaffected */
  }
}

/**
 * Remembers CCTP bridges run from this browser. The bridge is signed server-side
 * with the shared demo key, so this history is per-browser, not per-wallet.
 */
export interface StoredBridgeStep {
  name: string;
  txHash?: string;
  explorerUrl?: string;
  /**
   * What the runner said about this step, when it said anything.
   *
   * Absent means it simply happened. `active` is a step reported as started rather
   * than as finished, which is the difference between a record written as a run
   * goes and one written after it: the first can say which step a person is
   * waiting on, and that is the whole point of writing it down while it runs.
   * `noop` is a step that did not need to happen, `error` the one that failed.
   */
  state?: 'active' | 'noop' | 'error';
}
export interface StoredBridge {
  id: string;
  /** Which engine performed the move (older entries may be missing this). */
  engine?: BridgeEngine;
  /**
   * What kind of move it was. Absent means a transfer, which is what every record
   * written before deposits were recorded at all is.
   *
   * A deposit is distinguishable from a transfer by more than convention: it names
   * one chain at both ends, since the money does not travel. So does a Gateway
   * withdrawal back to its own chain, which is why this is written down rather
   * than inferred from the two chains being equal.
   */
  kind?: 'deposit' | 'subscription';
  /**
   * What the row is about, when the two chains do not say it: the subscription's
   * name. Written by the screen that made it, because the merchant label is a
   * local thing and no chain knows it.
   */
  label?: string;
  /**
   * When this record was last written to.
   *
   * A run that is interrupted -- the tab closed between the signature and the
   * receipt -- leaves a record saying `running` and nothing to ever finish it. The
   * row would claim to be in progress for good. Age is what tells that apart from
   * a run that genuinely is in progress, and `createdAt` cannot: a long transfer
   * is old and fine, while a stalled one may be a minute old.
   */
  updatedAt?: number;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  /**
   * Only set when the transfer was sent to someone else. Absent means it went to
   * the sender's own address, which is what a bridge normally is, and a row should
   * not show a "to" that is just you.
   */
  recipient?: string;
  amount: string;
  /**
   * `pending` | `success` | `error`, and for a Gateway spend whose mint failed,
   * `returning` then `returned`.
   *
   * Those last two are not decoration. A Gateway spend does not burn on the
   * source chain when the intent is accepted; Circle debits its own ledger and
   * the real burn happens later, at settlement. So a mint that fails means the
   * burn never ran and what left the balance was a hold, which Circle lets go
   * of. Calling that `error` tells the user their money is gone, next to an
   * amount that is on its way back.
   */
  state: string;
  steps: StoredBridgeStep[];
  createdAt: number;
  /**
   * The source-chain Gateway balance at the moment the failure was seen.
   *
   * The transfer's own status stays `failed` for good, so it can never report
   * the release. The balance is the only place it shows, and a figure to
   * compare against is the only way to know it has. Subunits, as a string,
   * because JSON has no bigint.
   */
  returnBaseline?: string;
  /** Circle's own words for why the mint failed, e.g. `ON_CHAIN_FAILURE`. */
  failureReason?: string;
  /**
   * The same failure as a symptom rather than as a sentence.
   *
   * A row outlives the language it failed in, and it outlives the wording: the
   * stored English of a wallet error would still be English after a switch to
   * Turkish, and would still be last year's phrasing after the sentence is
   * improved. The code is translated at the moment the row is drawn, and
   * `failureReason` stays as what the error itself said, for the detail view.
   */
  failureCode?: FailureCode;
  /**
   * What Circle charged, in display units, for the routes that charge.
   *
   * Absent on a deposit, which pays gas and nothing else, and absent on anything
   * recorded before this was written down. A row without a fee says nothing about
   * the fee rather than claiming it was free.
   */
  fee?: string;
}

const BRIDGES_KEY = 'ctrl-arcz:bridges';
const BRIDGE_PREFIX = 'ctrl-arcz:bridge:';

export function loadBridges(): StoredBridge[] {
  migrateArray<StoredBridge>(BRIDGES_KEY, BRIDGE_PREFIX, (b) => b.id);
  const rows = scan<StoredBridge>(BRIDGE_PREFIX).sort(
    (a, b) => (b.value.createdAt ?? 0) - (a.value.createdAt ?? 0),
  );
  prune(rows);
  return rows.slice(0, CAP).map(({ value }) => value);
}

/**
 * Record a transfer, replacing any earlier record of the same one.
 *
 * A wallet-signed bridge is written twice: once the moment the burn confirms, and
 * again when Circle's mint lands. The first write is the point -- it is what
 * survives a reload between the two, and the burn hash in it is what a stalled
 * transfer is recovered from. Appending blindly would leave the same transfer in
 * the list twice, once stuck on "pending" forever.
 */
export function saveBridge(bridge: StoredBridge): void {
  try {
    localStorage.setItem(BRIDGE_PREFIX + bridge.id, JSON.stringify(bridge));
  } catch {
    /* private mode or a full quota; the transfer itself is unaffected */
  }
}

/**
 * Forget a record entirely.
 *
 * For the one case where a transfer changes its own name: a Gateway spend is
 * written down before the wallet prompt, under an id made up on the spot, and then
 * takes Circle's transferId as its identity when Circle answers -- because that is
 * the id the mint is looked up by afterwards. Without this the row would be in the
 * list twice, once under a name nothing will ever ask about again.
 */
export function dropBridge(id: string): void {
  try {
    localStorage.removeItem(BRIDGE_PREFIX + id);
  } catch {
    /* nothing to do: the record is a note about a transfer, not the transfer */
  }
}
