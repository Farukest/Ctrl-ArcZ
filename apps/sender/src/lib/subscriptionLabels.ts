import type { Address } from 'viem';

/**
 * A subscription's name, and the one place a browser is allowed to disagree with
 * the chain about it.
 *
 * The name now travels in the box's stealth announcement, so it is the same on
 * every device and is read live with everything else. This file is the override on
 * top of that: renaming here is instant and free, where changing the announced
 * name would mean another transaction. So the local value wins when it exists, the
 * announced one is the default, and clearing the local one falls back rather than
 * blanking the name.
 *
 * It is also now the only thing about a subscription this app stores at all.
 * Merchant, caps, interval, expiry, spent, remaining and balance are all fetched
 * fresh from the chain every time.
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

/** The local override for this box, or empty when there is none. */
export function localLabel(account: Address): string {
  return load()[account.toLowerCase()] ?? '';
}

/**
 * What to show: this browser's override, else the name announced with the box.
 *
 * Order matters and only one way round makes sense. A person who renamed something
 * here meant it to stick, so an announced name must not overwrite it; and a box
 * they never renamed should still arrive named on a machine they have never opened
 * before.
 */
export function displayLabel(account: Address, announced = ''): string {
  return localLabel(account) || announced;
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
