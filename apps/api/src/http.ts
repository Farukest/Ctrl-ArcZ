import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { env } from './env.js';

const MAX_BODY_BYTES = 8 * 1024;

/** JSON response with BigInt-safe serialization (bigints become decimal strings). */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Read the raw request body under a hard size cap. A request stream can be read
 *  only once, so a handler that needs both the raw bytes (for a signature) and the
 *  parsed value must read raw once and JSON.parse it itself. */
export async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = c as Uint8Array;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString() || '{}';
}

/** Read and JSON-parse the request body under a hard size cap. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readRaw(req));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid json');
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * CORS. The mobile app sends no Origin header, so it is always allowed. Browsers
 * are allowed only if their origin is in CORS_ORIGINS (empty allows any). Handles
 * the preflight; returns true when the request is done (preflight answered).
 */
function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  // Fail closed: a browser Origin is allowed ONLY if it is on the explicit
  // allow-list. An empty list no longer means "allow any" — it means "no browser
  // origin is allowed" (the web apps call same-origin `/api/*` through nginx, so
  // they need no cross-origin grant; the mobile app sends no Origin and is allowed).
  const allowed = !origin || env.corsOrigins.includes(origin);
  if (origin && allowed) res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'content-type,x-ctrl-address,x-ctrl-timestamp,x-ctrl-signature',
  );
  res.setHeader('vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.statusCode = allowed ? 204 : 403;
    res.end();
    return true;
  }
  if (origin && !allowed) {
    json(res, 403, { error: 'origin not allowed' });
    return true;
  }
  return false;
}

/**
 * Per-IP sliding-window rate limit. The co-signer's firewall scan and any spend
 * endpoint are expensive, and the API is unauthenticated, so a hard cap per source
 * blunts amplification/DoS abuse. The client IP comes from nginx's
 * X-Forwarded-For (we sit behind a trusted reverse proxy on loopback).
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40; // requests per IP per minute
const MAX_TRACKED_IPS = 10_000; // hard ceiling so the map cannot grow without bound
const hits = new Map<string, number[]>();

/**
 * The real client IP. X-Forwarded-For is a CLIENT-CONTROLLABLE header: a client can
 * prepend arbitrary entries, and nginx (`$proxy_add_x_forwarded_for`) APPENDS the
 * real peer as the LAST entry. So we must take the rightmost hop, never the
 * leftmost — taking the leftmost let an attacker mint a fresh key per request and
 * evade the per-IP limit entirely (and grow the map unbounded). We trust exactly
 * one proxy hop (our nginx on loopback); the rightmost XFF value is the address it
 * observed.
 *
 * Exported for the regression test. Nothing outside this module calls it, but the
 * leftmost version of this function was a real hole, and a bug that has already
 * shipped once deserves a test that cannot be deleted by accident.
 */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  const parts = raw?.split(',').map((s) => s.trim()).filter(Boolean);
  const last = parts && parts.length > 0 ? parts[parts.length - 1] : undefined;
  return last || req.socket.remoteAddress || 'unknown';
}

function rateLimited(req: IncomingMessage, now: number): boolean {
  const ip = clientIp(req);
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  // Bound total keys: once the map is full, a genuinely new IP is rate-limited
  // rather than allowed to grow the map (the rightmost-hop fix already caps
  // cardinality to real client IPs, so this only bites under extreme load).
  if (!hits.has(ip) && hits.size >= MAX_TRACKED_IPS) return true;
  hits.set(ip, recent);
  return recent.length > RATE_MAX;
}

// Periodically drop stale buckets so the map tracks only currently-active IPs.
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref?.();

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;
export type Routes = Record<string, Handler>;

/**
 * Faults the caller can act on, told apart from faults they cannot.
 *
 * Everything unrecognised used to become `502 internal error`. The bridge outage of
 * 5 August was `Insufficient USDC balance on Arc Testnet` -- known exactly, logged
 * exactly, and reported to the client as an unexplained gateway failure. The app
 * then said "bridge service is not answering", which was false; the service was up
 * and its wallet was empty. Working that out took another engineer an afternoon of
 * elimination across four routes.
 *
 * 502 also claims something untrue. It means upstream did not answer. Upstream
 * answered and knew the reason.
 *
 * These patterns match messages the Circle kits and viem already produce. Anything
 * unmatched still becomes a 502, which is what that status was for.
 */
const KNOWN_FAULTS: Array<{ test: RegExp; status: number }> = [
  { test: /insufficient|not enough|exceeds balance|balance to cover/i, status: 400 },
  { test: /unsupported|not supported|invalid chain|unknown chain/i, status: 400 },
  { test: /user rejected|denied|declined/i, status: 400 },
  { test: /timeout|timed out|deadline/i, status: 504 },
  { test: /rate limit|429|request limit/i, status: 429 },
];

/** The status a thrown error deserves, and a message safe to hand a caller. */
export function classify(e: unknown): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  const raw = e instanceof Error ? e.message : String(e);
  const hit = KNOWN_FAULTS.find((f) => f.test.test(raw));
  // Only a matched, known fault is echoed back. An unrecognised message could carry
  // an RPC URL, a key fragment or a stack, so it stays in the log where it belongs.
  if (hit) return { status: hit.status, message: raw.slice(0, 300) };
  return { status: 502, message: 'internal error' };
}

/**
 * One level of `:param`, resolved only after an exact match misses. Not a router;
 * the day this needs more than that is the day it should stop being hand-written.
 * No route uses it right now, and it stays because deleting it would mean the next
 * `/thing/:id` arrives with a routing rewrite attached.
 */
function matchRoute(
  routes: Routes,
  method: string,
  pathname: string,
): { handler: Handler; params: Record<string, string> } | null {
  const parts = pathname.split('/');
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(' ');
    if (routeMethod !== method || !routePath?.includes('/:')) continue;
    const routeParts = routePath.split('/');
    if (routeParts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < routeParts.length; i++) {
      const rp = routeParts[i] as string;
      const p = parts[i] as string;
      if (rp.startsWith(':')) {
        if (!p) { ok = false; break; }
        params[rp.slice(1)] = decodeURIComponent(p);
      } else if (rp !== p) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

export function serve(routes: Routes): void {
  const server = createServer(async (req, res) => {
    try {
      if (applyCors(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://localhost');
      // Health is unmetered; everything else is rate limited per source IP.
      if (url.pathname !== '/api/health' && rateLimited(req, Date.now())) {
        return json(res, 429, { error: 'rate limited' });
      }
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (handler) {
        await handler(req, res, {});
      } else {
        const matched = matchRoute(routes, req.method ?? 'GET', url.pathname);
        if (!matched) return json(res, 404, { error: 'not found' });
        await matched.handler(req, res, matched.params);
      }
    } catch (e) {
      const { status, message } = classify(e);
      // Log the original either way: the caller gets a curated line, whoever is
      // debugging gets all of it.
      if (status >= 500) {
        console.error(`${req.method} ${req.url} failed:`, e instanceof Error ? e.message : e);
      }
      json(res, status, { error: message });
    }
  });
  // Bind to loopback only: the API is reached exclusively through the nginx
  // reverse proxy (TLS), never directly, so port 8787 is not exposed on the host.
  server.listen(env.port, '127.0.0.1', () => {
    console.log(`ctrl-arcz api listening on 127.0.0.1:${env.port}`);
  });
}
