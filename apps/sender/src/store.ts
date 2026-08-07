/**
 * Remembers the transfers this browser created, so the "active transfers" tab can
 * list them and show their claim codes. The chain is the source of truth for
 * status; this only records which ids belong to this sender and the code we minted
 * (a sender legitimately holds the code to share it with the recipient).
 */
import type { Address, Hex } from 'viem';
import type { BridgeEngine } from '@ctrl-arcz/demo-kit';

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

export function loadTransfers(sender: Address): StoredTransfer[] {
  try {
    const raw = localStorage.getItem(key(sender));
    const stored = raw ? (JSON.parse(raw) as StoredTransfer[]) : [];
    // Re-attach any secret we still hold in memory for this session.
    return stored.map((t) => ({ ...t, secret: sessionSecrets.get(t.transferId) ?? '' }));
  } catch {
    return [];
  }
}

export function saveTransfer(sender: Address, transfer: StoredTransfer): void {
  if (transfer.secret) sessionSecrets.set(transfer.transferId, transfer.secret);
  const all = loadTransfers(sender);
  all.unshift(transfer);
  // Persist everything EXCEPT the secret.
  const persistable = all.slice(0, 50).map(({ secret: _secret, ...rest }) => rest);
  localStorage.setItem(key(sender), JSON.stringify(persistable));
}

/**
 * Remembers CCTP bridges run from this browser. The bridge is signed server-side
 * with the shared demo key, so this history is per-browser, not per-wallet.
 */
export interface StoredBridgeStep {
  name: string;
  txHash?: string;
  explorerUrl?: string;
}
export interface StoredBridge {
  id: string;
  /** Which engine performed the move (older entries may be missing this). */
  engine?: BridgeEngine;
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
  state: string;
  steps: StoredBridgeStep[];
  createdAt: number;
}

const BRIDGES_KEY = 'ctrl-arcz:bridges';

export function loadBridges(): StoredBridge[] {
  try {
    const raw = localStorage.getItem(BRIDGES_KEY);
    return raw ? (JSON.parse(raw) as StoredBridge[]) : [];
  } catch {
    return [];
  }
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
  const all = loadBridges().filter((b) => b.id !== bridge.id);
  all.unshift(bridge);
  localStorage.setItem(BRIDGES_KEY, JSON.stringify(all.slice(0, 50)));
}
