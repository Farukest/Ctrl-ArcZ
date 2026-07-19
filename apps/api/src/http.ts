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
 */
function clientIp(req: IncomingMessage): string {
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

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
export type Routes = Record<string, Handler>;

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
      if (!handler) return json(res, 404, { error: 'not found' });
      await handler(req, res);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      // eslint-disable-next-line no-console
      console.error(`${req.method} ${req.url} failed:`, e instanceof Error ? e.message : e);
      json(res, 502, { error: 'internal error' });
    }
  });
  // Bind to loopback only: the API is reached exclusively through the nginx
  // reverse proxy (TLS), never directly, so port 8787 is not exposed on the host.
  server.listen(env.port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`ctrl-arcz api listening on 127.0.0.1:${env.port}`);
  });
}
