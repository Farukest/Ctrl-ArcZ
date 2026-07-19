import type { IncomingMessage } from 'node:http';
import { keccak256, recoverMessageAddress, toBytes, isAddress, type Address, type Hex } from 'viem';
import { HttpError } from './http.js';

const MAX_SKEW_MS = 120_000;

/**
 * The exact message a client signs to authenticate a request to a relayer-funded
 * endpoint. It binds the path, a fresh timestamp, and a hash of the body, so a
 * signature is single-use for that one call and cannot be replayed onto a
 * different endpoint or body.
 */
export function requestMessage(path: string, timestamp: string, rawBody: string): string {
  return `Ctrl+ArcZ API request\npath: ${path}\nts: ${timestamp}\nbody: ${keccak256(toBytes(rawBody))}`;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Require a valid X-Ctrl-Address / X-Ctrl-Timestamp / X-Ctrl-Signature triple over
 * this request. Returns the authenticated caller address, or throws 401. This is
 * what makes the funded relayer endpoints safe to expose: an anonymous caller
 * cannot spend, and each authenticated caller is quota-limited.
 */
export async function requireSignedRequest(
  req: IncomingMessage,
  rawBody: string,
  path: string,
): Promise<Address> {
  const address = header(req, 'x-ctrl-address');
  const timestamp = header(req, 'x-ctrl-timestamp');
  const signature = header(req, 'x-ctrl-signature');
  if (!address || !isAddress(address)) throw new HttpError(401, 'missing or invalid address');
  if (!timestamp || !/^\d+$/.test(timestamp)) throw new HttpError(401, 'missing timestamp');
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new HttpError(401, 'missing signature');
  if (Math.abs(Date.now() - Number(timestamp)) > MAX_SKEW_MS) throw new HttpError(401, 'stale request');

  const recovered = await recoverMessageAddress({
    message: requestMessage(path, timestamp, rawBody),
    signature: signature as Hex,
  });
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new HttpError(401, 'signature does not match address');
  }
  return address;
}

// Per-address daily quota for relayer-funded actions (units are USDC for the
// bridge/gateway, 1 per gasless claim). Bounds the blast radius per caller.
const DAILY_LIMIT = 50;
const usage = new Map<string, { day: number; used: number }>();

export function checkQuota(address: Address, units: number): void {
  const day = Math.floor(Date.now() / 86_400_000);
  const k = address.toLowerCase();
  const cur = usage.get(k);
  const used = cur && cur.day === day ? cur.used : 0;
  if (used + units > DAILY_LIMIT) throw new HttpError(429, 'daily quota exceeded');
  usage.set(k, { day, used: used + units });
}
