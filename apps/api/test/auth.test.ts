import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  checkQuota,
  requestMessage,
  requireSignedRequest,
  takeInvestigatorBudget,
} from '../src/auth.js';

const PATH = '/api/relay/create';

/**
 * A fresh key per run rather than a constant. Nothing here depends on a particular
 * address, and a 32-byte private key committed to a repository is a thing people
 * copy out of a repository.
 */
const account = () => privateKeyToAccount(generatePrivateKey());

/** A request that carries only what `requireSignedRequest` reads. */
function signed(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

async function sign(
  signer: ReturnType<typeof account>,
  opts: { path?: string; body?: string; timestamp?: string } = {},
) {
  const path = opts.path ?? PATH;
  const rawBody = opts.body ?? '{"amount":"1"}';
  const timestamp = opts.timestamp ?? String(Date.now());
  const signature = await signer.signMessage({ message: requestMessage(path, timestamp, rawBody) });
  return { path, rawBody, timestamp, signature };
}

/** A brand new address, so one test's quota is never another test's ceiling. */
let n = 0;
const freshAddress = (): Address =>
  (`0x${(++n).toString(16).padStart(40, 'a')}` as Address).toLowerCase() as Address;

afterEach(() => {
  vi.useRealTimers();
});

describe('requestMessage', () => {
  it('binds the path, the timestamp and a hash of the body', () => {
    const m = requestMessage('/api/x', '1700000000000', '{"a":1}');
    expect(m).toBe(
      [
        'Ctrl+ArcZ API request',
        'path: /api/x',
        'ts: 1700000000000',
        `body: ${keccak256(toBytes('{"a":1}'))}`,
      ].join('\n'),
    );
  });

  it('hashes the body rather than quoting it, so the message stays one line per field', () => {
    // A body pasted in verbatim could contain a newline and forge a field.
    const m = requestMessage('/api/x', '1', 'ts: 2\npath: /api/drain');
    expect(m.split('\n')).toHaveLength(4);
  });

  it('changes when any one of the three inputs changes', () => {
    const base = requestMessage('/api/x', '1', 'b');
    expect(requestMessage('/api/y', '1', 'b')).not.toBe(base);
    expect(requestMessage('/api/x', '2', 'b')).not.toBe(base);
    expect(requestMessage('/api/x', '1', 'c')).not.toBe(base);
  });
});

describe('requireSignedRequest', () => {
  it('returns the caller when the signature matches', async () => {
    const signer = account();
    const s = await sign(signer);
    const who = await requireSignedRequest(
      signed({
        'x-ctrl-address': signer.address,
        'x-ctrl-timestamp': s.timestamp,
        'x-ctrl-signature': s.signature,
      }),
      s.rawBody,
      s.path,
    );
    expect(who.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it.each([
    ['no address at all', { 'x-ctrl-address': undefined }],
    ['something that is not an address', { 'x-ctrl-address': 'alice' }],
    ['a timestamp that is not a number', { 'x-ctrl-timestamp': 'now' }],
    ['no timestamp', { 'x-ctrl-timestamp': undefined }],
    ['a signature that is not hex', { 'x-ctrl-signature': 'not-a-signature' }],
    ['no signature', { 'x-ctrl-signature': undefined }],
  ])('rejects a request with %s', async (_label, override) => {
    const signer = account();
    const s = await sign(signer);
    await expect(
      requireSignedRequest(
        signed({
          'x-ctrl-address': signer.address,
          'x-ctrl-timestamp': s.timestamp,
          'x-ctrl-signature': s.signature,
          ...override,
        }),
        s.rawBody,
        s.path,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a signature older than the skew window', async () => {
    const signer = account();
    const s = await sign(signer, { timestamp: String(Date.now() - 130_000) });
    await expect(
      requireSignedRequest(
        signed({
          'x-ctrl-address': signer.address,
          'x-ctrl-timestamp': s.timestamp,
          'x-ctrl-signature': s.signature,
        }),
        s.rawBody,
        s.path,
      ),
    ).rejects.toMatchObject({ status: 401, message: 'stale request' });
  });

  it('rejects a timestamp from the future by the same margin', async () => {
    // Skew is absolute. A clock the caller controls must not buy them a longer window.
    const signer = account();
    const s = await sign(signer, { timestamp: String(Date.now() + 130_000) });
    await expect(
      requireSignedRequest(
        signed({
          'x-ctrl-address': signer.address,
          'x-ctrl-timestamp': s.timestamp,
          'x-ctrl-signature': s.signature,
        }),
        s.rawBody,
        s.path,
      ),
    ).rejects.toMatchObject({ status: 401, message: 'stale request' });
  });

  it('rejects a valid signature presented under an address that did not sign it', async () => {
    const signer = account();
    const victim = account();
    const s = await sign(signer);
    await expect(
      requireSignedRequest(
        signed({
          'x-ctrl-address': victim.address,
          'x-ctrl-timestamp': s.timestamp,
          'x-ctrl-signature': s.signature,
        }),
        s.rawBody,
        s.path,
      ),
    ).rejects.toMatchObject({ status: 401, message: 'signature does not match address' });
  });

  it('rejects a body swapped after signing', async () => {
    // The point of hashing the body into the message: a captured signature cannot be
    // moved onto a larger amount.
    const signer = account();
    const s = await sign(signer, { body: '{"amount":"1"}' });
    await expect(
      requireSignedRequest(
        signed({
          'x-ctrl-address': signer.address,
          'x-ctrl-timestamp': s.timestamp,
          'x-ctrl-signature': s.signature,
        }),
        '{"amount":"1000"}',
        s.path,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a signature replayed onto a different endpoint', async () => {
    const signer = account();
    const s = await sign(signer, { path: '/api/relay/announce' });
    await expect(
      requireSignedRequest(
        signed({
          'x-ctrl-address': signer.address,
          'x-ctrl-timestamp': s.timestamp,
          'x-ctrl-signature': s.signature,
        }),
        s.rawBody,
        '/api/relay/gas',
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('accepts a signature once and refuses the same one afterwards', async () => {
    // Inside the skew window everything about a captured request still verifies. The
    // nonce store is the only thing that stops it being submitted twice.
    const signer = account();
    const s = await sign(signer);
    const headers = signed({
      'x-ctrl-address': signer.address,
      'x-ctrl-timestamp': s.timestamp,
      'x-ctrl-signature': s.signature,
    });
    await expect(requireSignedRequest(headers, s.rawBody, s.path)).resolves.toBeTruthy();
    await expect(requireSignedRequest(headers, s.rawBody, s.path)).rejects.toMatchObject({
      status: 401,
      message: 'request already used',
    });
  });

  it('rejects an ECDSA-malleable twin of an already-used signature', async () => {
    // A captured signature can be reshaped into a different 65-byte value that still
    // recovers to the same signer over the same message (s -> n-s, v flipped). When
    // the nonce was keyed by the signature bytes this twin sailed past the replay
    // check; keyed by (recovered signer, message) it lands on the same nonce.
    const signer = account();
    const s = await sign(signer);
    const first = signed({
      'x-ctrl-address': signer.address,
      'x-ctrl-timestamp': s.timestamp,
      'x-ctrl-signature': s.signature,
    });
    await expect(requireSignedRequest(first, s.rawBody, s.path)).resolves.toBeTruthy();

    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const hex = s.signature.slice(2);
    const r = hex.slice(0, 64);
    const sValue = BigInt('0x' + hex.slice(64, 128));
    const v = parseInt(hex.slice(128, 130), 16);
    const twin = ('0x' +
      r +
      (N - sValue).toString(16).padStart(64, '0') +
      (v === 27 ? 28 : 27).toString(16).padStart(2, '0')) as `0x${string}`;
    expect(twin).not.toBe(s.signature);

    const twinReq = signed({
      'x-ctrl-address': signer.address,
      'x-ctrl-timestamp': s.timestamp,
      'x-ctrl-signature': twin,
    });
    await expect(requireSignedRequest(twinReq, s.rawBody, s.path)).rejects.toMatchObject({
      status: 401,
      message: 'request already used',
    });
  });
});

describe('checkQuota', () => {
  it('allows a caller up to their daily limit', () => {
    const a = freshAddress();
    expect(() => checkQuota(a, 50)).not.toThrow();
  });

  it('refuses the unit that would cross the limit, not the one after it', () => {
    const a = freshAddress();
    checkQuota(a, 50);
    expect(() => checkQuota(a, 1)).toThrow('daily quota exceeded');
  });

  it('rejects a single oversized request outright', () => {
    expect(() => checkQuota(freshAddress(), 51)).toThrow('daily quota exceeded');
  });

  it('keeps one caller spending out of the budget of another', () => {
    const a = freshAddress();
    checkQuota(a, 50);
    expect(() => checkQuota(freshAddress(), 50)).not.toThrow();
  });

  it('treats an address as one caller whatever case it is written in', () => {
    // Otherwise the same wallet gets a fresh 50 for every capitalisation of itself.
    const lower = freshAddress();
    const upper = ('0x' + lower.slice(2).toUpperCase()) as Address;
    checkQuota(lower, 50);
    expect(() => checkQuota(upper, 1)).toThrow('daily quota exceeded');
  });

  it('does not charge a caller for the request it refused', () => {
    const a = freshAddress();
    checkQuota(a, 40);
    expect(() => checkQuota(a, 20)).toThrow();
    expect(() => checkQuota(a, 10)).not.toThrow();
  });

  it('gives the caller their limit back the next day', () => {
    const a = freshAddress();
    checkQuota(a, 50);
    expect(() => checkQuota(a, 1)).toThrow();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    expect(() => checkQuota(a, 50)).not.toThrow();
  });
});

describe('takeInvestigatorBudget', () => {
  it('answers rather than throws, because the risk check carries it', () => {
    expect(typeof takeInvestigatorBudget()).toBe('boolean');
  });

  it('stops granting once the calls for the day are spent, and starts again tomorrow', () => {
    // The ceiling bounds the model bill. Reaching it degrades the advisory to the rule
    // verdict alone, which is how the route already behaves with no API key at all.
    while (takeInvestigatorBudget()) {
      /* spend the day's budget */
    }
    expect(takeInvestigatorBudget()).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    expect(takeInvestigatorBudget()).toBe(true);
  });
});

/**
 * Last on purpose. It exhausts the process-wide counter, and that counter is module
 * state shared with every test above.
 */
describe('the process ceiling', () => {
  it('stops a caller who is individually within their limit', () => {
    // Addresses are free to mint, so a per-address cap alone lets one operator spend
    // 50 units per wallet without bound. Every call below is a fresh address asking
    // for exactly its allowance, so nothing here can trip the per-address limit: the
    // refusal, when it comes, is the global one.
    let refused = false;
    for (let i = 0; i < 45 && !refused; i++) {
      try {
        checkQuota(freshAddress(), 50);
      } catch {
        refused = true;
      }
    }
    expect(refused).toBe(true);
  });
});
