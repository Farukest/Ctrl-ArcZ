import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { isAddress, type Address } from 'viem';
import { json, readJson, HttpError } from './http.js';

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
    writeFileSync(STORE, JSON.stringify(reg));
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
  const set = new Set(registry[k] ?? []);
  set.add(token);
  registry[k] = [...set];
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

// --- HTTP: POST /api/notifications/register { address, token } ---

export async function registerHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { address, token } = (await readJson(req)) as { address?: unknown; token?: unknown };
  if (typeof address !== 'string' || !isAddress(address)) throw new HttpError(400, 'invalid address');
  if (typeof token !== 'string') throw new HttpError(400, 'invalid token');
  registerToken(address, token);
  json(res, 200, { ok: true });
}
