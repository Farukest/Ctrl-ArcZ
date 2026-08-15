import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { HttpError, classify, clientIp, json, readJson, readRaw } from '../src/http.js';

/** A request that is only ever asked for its headers and its socket. */
function req(headers: IncomingMessage['headers'], remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

/** A request that is a body. `Readable.from` gives the async iteration `readRaw` does. */
function body(...chunks: string[]): IncomingMessage {
  return Readable.from(chunks.map((c) => Buffer.from(c))) as unknown as IncomingMessage;
}

/** Captures what a handler wrote, instead of writing it to a socket. */
function res() {
  const sent = { status: 0, headers: {} as Record<string, string>, payload: '' };
  const r = {
    set statusCode(v: number) {
      sent.status = v;
    },
    setHeader(k: string, v: string) {
      sent.headers[k] = v;
    },
    end(payload: string) {
      sent.payload = payload;
    },
  };
  return { res: r as unknown as ServerResponse, sent };
}

describe('clientIp', () => {
  // The addresses below are RFC 5737 documentation ranges, so nothing here names a
  // real host.

  it('takes the rightmost hop, which is the one nginx appended', () => {
    // The regression. `$proxy_add_x_forwarded_for` appends the peer it actually saw,
    // so the real client is last. Reading the first entry reads a value the client
    // typed, which is what let one attacker mint a fresh rate-limit key per request.
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9, 198.51.100.4' }))).toBe('198.51.100.4');
  });

  it('is not fooled by a forged chain, however long', () => {
    const forged = Array.from({ length: 50 }, (_, i) => `203.0.113.${i}`).join(', ');
    expect(clientIp(req({ 'x-forwarded-for': `${forged}, 198.51.100.4` }))).toBe('198.51.100.4');
  });

  it('reads the last value when the header arrives more than once', () => {
    expect(clientIp(req({ 'x-forwarded-for': ['203.0.113.9', '198.51.100.4'] }))).toBe(
      '198.51.100.4',
    );
  });

  it('trims the whitespace nginx leaves after each comma', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9,   198.51.100.4  ' }))).toBe(
      '198.51.100.4',
    );
  });

  it('falls back to the socket when there is no proxy header', () => {
    expect(clientIp(req({}, '198.51.100.7'))).toBe('198.51.100.7');
  });

  it('falls back to the socket rather than to an empty header', () => {
    // An empty or comma-only header must not become the rate-limit key: every such
    // request would share one bucket, or worse, key on ''.
    expect(clientIp(req({ 'x-forwarded-for': '' }, '198.51.100.7'))).toBe('198.51.100.7');
    expect(clientIp(req({ 'x-forwarded-for': ' , , ' }, '198.51.100.7'))).toBe('198.51.100.7');
  });

  it('never returns nothing, because the caller uses it as a map key', () => {
    expect(clientIp(req({}))).toBe('unknown');
  });
});

describe('classify', () => {
  it('passes an HttpError through with its own status and message', () => {
    expect(classify(new HttpError(429, 'daily quota exceeded'))).toEqual({
      status: 429,
      message: 'daily quota exceeded',
    });
  });

  it.each([
    ['Insufficient USDC balance on Arc Testnet', 400],
    ['chain 999 is not supported', 400],
    ['user rejected the request', 400],
    ['request timed out after 30s', 504],
    ['rate limit reached, retry later', 429],
  ])('tells the caller about %s, which they can act on', (message, status) => {
    const c = classify(new Error(message));
    expect(c.status).toBe(status);
    expect(c.message).toBe(message);
  });

  it('does not echo an unrecognised error, whatever it contains', () => {
    // The reason the default is opaque: an unmatched message may carry an RPC URL, a
    // key fragment or a stack. It belongs in the log, not in the response.
    const c = classify(new Error('connect ECONNREFUSED https://rpc.internal/?key=abcdef123456'));
    expect(c).toEqual({ status: 502, message: 'internal error' });
  });

  it('handles a thrown non-Error without crashing the response path', () => {
    expect(classify('something odd')).toEqual({ status: 502, message: 'internal error' });
    expect(classify(undefined)).toEqual({ status: 502, message: 'internal error' });
  });

  it('caps how much of a known message it repeats', () => {
    const c = classify(new Error(`insufficient ${'x'.repeat(500)}`));
    expect(c.message).toHaveLength(300);
  });
});

describe('readRaw and readJson', () => {
  it('joins the chunks a stream arrives in', async () => {
    expect(await readRaw(body('{"a"', ':1}'))).toBe('{"a":1}');
  });

  it('turns an empty body into an empty object, so a handler need not special-case it', async () => {
    expect(await readRaw(body())).toBe('{}');
    expect(await readJson(body())).toEqual({});
  });

  it('refuses a body over the cap rather than buffering it', async () => {
    await expect(readRaw(body('x'.repeat(8 * 1024 + 1)))).rejects.toMatchObject({ status: 413 });
  });

  it('reports malformed json as a 400 the caller can act on', async () => {
    await expect(readJson(body('{not json'))).rejects.toMatchObject({ status: 400 });
  });

  it('does not relabel an oversized body as a parse error on the way out', async () => {
    // readJson wraps readRaw in a try/catch. Without the HttpError re-throw, a body
    // that was too large would come back as "invalid json", which sends whoever is
    // debugging to the wrong place entirely.
    await expect(readJson(body('y'.repeat(8 * 1024 + 1)))).rejects.toMatchObject({ status: 413 });
  });
});

describe('json', () => {
  it('serialises a bigint, which JSON.stringify would throw on', () => {
    const { res: r, sent } = res();
    json(r, 200, { transferId: 42n, to: '0x00' });
    expect(sent.status).toBe(200);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent.payload)).toEqual({ transferId: '42', to: '0x00' });
  });
});
