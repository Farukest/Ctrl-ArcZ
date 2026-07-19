import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { isAddress, recoverMessageAddress, type Address, type Hex } from 'viem';
import { json, readJson, HttpError } from './http.js';

const MAX_TOKENS_PER_ADDRESS = 10;
const MAX_ADDRESSES = 50_000; // hard ceiling so the registry cannot grow unbounded
const REGISTRATION_SKEW_MS = 120_000;

/**
 * Device push-token registry, keyed by wallet address. A user may have several
 * devices, so each address maps to a set of Expo push tokens. Persisted to a
 * small JSON file so registrations survive a restart. For a single-node demo this
 * is enough; a production deploy would use a database.
 */
const STORE = fileURLToPath(new URL('../.tokens.json', import.meta.url));
type Registry = Record<string, string[]>;

function load(): Registry {
  try {
    return existsSync(STORE) ? (JSON.parse(readFileSync(STORE, 'utf8')) as Registry) : {};
  } catch {
    return {};
  }
}
function save(reg: Registry): void {
  try {
    // Atomic write: a crash mid-write must not truncate the registry.
    const tmp = `${STORE}.tmp`;
    writeFileSync(tmp, JSON.stringify(reg));
    renameSync(tmp, STORE);
  } catch (e) {
    console.error('failed to persist token registry:', e instanceof Error ? e.message : e);
  }
}

const registry: Registry = load();
const expo = new Expo();

function key(address: Address): string {
  return address.toLowerCase();
}

export function registerToken(address: Address, token: string): void {
  if (!Expo.isExpoPushToken(token)) throw new HttpError(400, 'invalid expo push token');
  const k = key(address);
  // Refuse a brand-new address once the registry is full (existing addresses may
  // still add/replace tokens). Keeps the store bounded under abuse.
  if (registry[k] === undefined && Object.keys(registry).length >= MAX_ADDRESSES) {
    throw new HttpError(429, 'registry full');
  }
  const set = new Set(registry[k] ?? []);
  set.add(token);
  // Cap devices per address so a caller cannot grow the store unbounded; keep the
  // most recent.
  registry[k] = [...set].slice(-MAX_TOKENS_PER_ADDRESS);
  save(registry);
}

export function tokensFor(address: Address): string[] {
  return registry[key(address)] ?? [];
}

/** Send a push to every device registered for an address. Prunes tokens Expo
 *  reports as no longer valid. No-op when the address has no devices. */
export async function push(
  address: Address,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const tokens = tokensFor(address).filter((t) => Expo.isExpoPushToken(t));
  if (tokens.length === 0) return;
  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
    title,
    body,
    sound: 'default',
    ...(data ? { data } : {}),
  }));
  try {
    for (const chunk of expo.chunkPushNotifications(messages)) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (e) {
    console.error('push send failed:', e instanceof Error ? e.message : e);
  }
}

// --- HTTP: POST /api/notifications/register { address, token, signature } ---

/** The exact message a client must sign with `address` to register `token`. This
 *  proves control of the address (so an attacker cannot subscribe their device to a
 *  victim's payment events) and is timestamped so a captured registration cannot be
 *  replayed indefinitely. */
export function registrationMessage(address: Address, token: string, ts: number): string {
  return `Ctrl+ArcZ push registration\naddress: ${address.toLowerCase()}\ntoken: ${token}\nts: ${ts}`;
}

export async function registerHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { address, token, signature, ts } = (await readJson(req)) as {
    address?: unknown;
    token?: unknown;
    signature?: unknown;
    ts?: unknown;
  };
  if (typeof address !== 'string' || !isAddress(address)) throw new HttpError(400, 'invalid address');
  if (typeof token !== 'string' || !Expo.isExpoPushToken(token)) throw new HttpError(400, 'invalid token');
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new HttpError(400, 'invalid signature');
  }
  if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > REGISTRATION_SKEW_MS) {
    throw new HttpError(401, 'stale or missing timestamp');
  }
  // Prove the caller controls `address` before subscribing a device to its events.
  const recovered = await recoverMessageAddress({
    message: registrationMessage(address, token, ts),
    signature: signature as Hex,
  });
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new HttpError(401, 'signature does not match address');
  }
  registerToken(address, token);
  json(res, 200, { ok: true });
}
