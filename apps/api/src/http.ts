import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { env } from './env.js';

const MAX_BODY_BYTES = 8 * 1024;

/** JSON response with BigInt-safe serialization (bigints become decimal strings). */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Read and JSON-parse the request body under a hard size cap. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = c as Uint8Array;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString() || '{}';
  try {
    return JSON.parse(raw);
  } catch {
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
  res.setHeader('access-control-allow-headers', 'content-type');
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

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
export type Routes = Record<string, Handler>;

export function serve(routes: Routes): void {
  const server = createServer(async (req, res) => {
    try {
      if (applyCors(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://localhost');
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
  server.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`ctrl-arcz api listening on :${env.port}`);
  });
}
