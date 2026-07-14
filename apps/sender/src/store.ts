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

export function loadTransfers(sender: Address): StoredTransfer[] {
  try {
    const raw = localStorage.getItem(key(sender));
    return raw ? (JSON.parse(raw) as StoredTransfer[]) : [];
  } catch {
    return [];
  }
}

export function saveTransfer(sender: Address, transfer: StoredTransfer): void {
  const all = loadTransfers(sender);
  all.unshift(transfer);
  localStorage.setItem(key(sender), JSON.stringify(all.slice(0, 50)));
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
