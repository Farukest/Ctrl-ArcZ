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
  code: string;
  salt: Hex;
  txHash: Hex;
  createdAt: number;
}

const key = (sender: Address) => `ctrl-arcz:sender:${sender.toLowerCase()}`;

/**
 * The claim `code` is the out-of-band secret that gates a claim, so it is NEVER
 * written to localStorage: on disk it would be a bearer credential that any future
 * script-injection on this origin could exfiltrate to drain every outstanding
 * transfer (the salt alone cannot claim; the code is the missing factor). Instead we
 * keep codes in memory for the current session only — enough for the active-transfers
 * tab to show a code you just minted, gone on refresh. Share the code when you send.
 */
const sessionCodes = new Map<string, string>();

export function loadTransfers(sender: Address): StoredTransfer[] {
  try {
    const raw = localStorage.getItem(key(sender));
    const stored = raw ? (JSON.parse(raw) as StoredTransfer[]) : [];
    // Re-attach any code we still hold in memory for this session.
    return stored.map((t) => ({ ...t, code: sessionCodes.get(t.transferId) ?? t.code ?? '' }));
  } catch {
    return [];
  }
}

export function saveTransfer(sender: Address, transfer: StoredTransfer): void {
  if (transfer.code) sessionCodes.set(transfer.transferId, transfer.code);
  const all = loadTransfers(sender);
  all.unshift(transfer);
  // Persist everything EXCEPT the code.
  const persistable = all.slice(0, 50).map(({ code: _code, ...rest }) => rest);
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

export function saveBridge(bridge: StoredBridge): void {
  const all = loadBridges();
  all.unshift(bridge);
  localStorage.setItem(BRIDGES_KEY, JSON.stringify(all.slice(0, 50)));
}
