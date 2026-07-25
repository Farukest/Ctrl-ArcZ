import type { Address } from 'viem';

/**
 * Optional human labels for subscriptions (e.g. "Netflix"), kept per browser. The
 * chain stores no name, so this is a local convenience only; losing it never loses
 * the subscription (it is always identified on-chain by its account address).
 */
const KEY = 'ctrl-arcz:sub-labels';

type Labels = Record<string, string>;

function load(): Labels {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Labels) : {};
  } catch {
    return {};
  }
}

export function getLabel(account: Address): string {
  return load()[account.toLowerCase()] ?? '';
}

export function setLabel(account: Address, label: string): void {
  const all = load();
  const k = account.toLowerCase();
  if (label.trim()) all[k] = label.trim().slice(0, 40);
  else delete all[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
