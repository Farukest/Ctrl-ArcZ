/**
 * Remembers the transfers this browser created, so the "active transfers" tab can
 * list them and show their claim codes. The chain is the source of truth for
 * status; this only records which ids belong to this sender and the code we minted
 * (a sender legitimately holds the code to share it with the recipient).
 */
import type { Address, Hex } from 'viem';

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
