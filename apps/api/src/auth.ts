import type { IncomingMessage } from 'node:http';
import {
  keccak256,
  recoverMessageAddress,
  toBytes,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
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

  // Anti-replay: even within the 120s skew window, a captured request may not be
  // re-submitted. The signature already binds path+ts+bodyHash, so its hash is a
  // natural single-use nonce. Reject a repeat; remember it until its skew expires.
  const nonce = keccak256(toBytes(signature));
  const now = Date.now();
  const seenAt = usedSignatures.get(nonce);
  if (seenAt !== undefined && now - seenAt < MAX_SKEW_MS) {
    throw new HttpError(401, 'request already used');
  }
  usedSignatures.set(nonce, now);
  return address;
}

/**
 * A daily ceiling on investigator calls, counted for the whole process.
 *
 * The route is deliberately unauthenticated: it reads public chain data and
 * returns an opinion, it moves no money, and it is the firewall's second half.
 * Making someone sign a wallet prompt to be told an address looks wrong is
 * asking the user to pay for their own protection, and a prompt on every page
 * load is how people learn to click through prompts.
 *
 * What actually needs defending is the operator's model spend, and an address
 * proves nothing about that -- addresses are free to mint. The per-IP sliding
 * window in `http.ts` blunts a single abuser; this bounds the bill no matter how
 * many addresses or IPs are involved. Past the ceiling the route still answers,
 * with the rule verdict alone, which is exactly how it behaves with no API key.
 */
const INVESTIGATOR_DAILY_LIMIT = 1_000;
let investigatorUsage = { day: -1, used: 0 };

/** True when there is budget for one more model call today. Never throws: running
 *  out must degrade the advisory, not fail the risk check that carries it. */
export function takeInvestigatorBudget(): boolean {
  const day = Math.floor(Date.now() / 86_400_000);
  if (investigatorUsage.day !== day) investigatorUsage = { day, used: 0 };
  if (investigatorUsage.used >= INVESTIGATOR_DAILY_LIMIT) return false;
  investigatorUsage.used += 1;
  return true;
}

/** Single-use nonce store for signed requests (keyed by signature hash). Swept so
 *  it only holds signatures still inside the freshness window. */
const usedSignatures = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of usedSignatures) if (now - t >= MAX_SKEW_MS) usedSignatures.delete(k);
}, MAX_SKEW_MS).unref?.();

// Per-address daily quota for relayer-funded actions (units are USDC for the
// bridge/gateway, 1 per gasless claim). Bounds the blast radius per caller.
const DAILY_LIMIT = 50;
// Addresses are free to generate, so a per-address cap alone lets an attacker
// multiply spend across K wallets. A process-wide daily ceiling caps the relayer's
// total exposure regardless of how many addresses are used.
const GLOBAL_DAILY_LIMIT = 2_000;
const usage = new Map<string, { day: number; used: number }>();
let globalUsage = { day: -1, used: 0 };

export function checkQuota(address: Address, units: number): void {
  const day = Math.floor(Date.now() / 86_400_000);

  // Global ceiling first: refuse before touching per-address state.
  if (globalUsage.day !== day) globalUsage = { day, used: 0 };
  if (globalUsage.used + units > GLOBAL_DAILY_LIMIT) {
    throw new HttpError(429, 'daily quota exceeded');
  }

  const k = address.toLowerCase();
  const cur = usage.get(k);
  const used = cur && cur.day === day ? cur.used : 0;
  if (used + units > DAILY_LIMIT) throw new HttpError(429, 'daily quota exceeded');

  usage.set(k, { day, used: used + units });
  globalUsage = { day, used: globalUsage.used + units };
}

// Drop entries from a previous day so the per-address map does not grow unbounded.
setInterval(() => {
  const day = Math.floor(Date.now() / 86_400_000);
  for (const [k, v] of usage) if (v.day !== day) usage.delete(k);
}, 3_600_000).unref?.();
