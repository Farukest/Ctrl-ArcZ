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
  const allowed =
    !origin || env.corsOrigins.length === 0 || env.corsOrigins.includes(origin);
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
const hits = new Map<string, number[]>();

function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

function rateLimited(req: IncomingMessage, now: number): boolean {
  const ip = clientIp(req);
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_MAX;
}

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
