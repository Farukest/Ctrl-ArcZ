import { beforeAll, describe, expect, it } from 'vitest';
import type * as NanoModule from '../src/nano.js';

/**
 * The pay-per-request agent wallet: who it belongs to and who may spend it.
 * No network: the key and token are pure functions of the secret and the user.
 */
const A = '0xf9e7f9B3b158CdACa3a1b5399bBA5D5b8a554fcE';
const B = '0x05a1906B5260de007ccfeF2Be5e6d6da72849577';

let nano: typeof NanoModule;

beforeAll(async () => {
  process.env.NANO_AGENT_SECRET = 'test-secret-that-is-long-enough-000000';
  process.env.NANO_LOG_PATH = `${process.env.TEMP ?? '/tmp'}/nano-usage-test-${Date.now()}.jsonl`;
  nano = await import('../src/nano.js');
});

describe('agent wallet', () => {
  it('is the same wallet every time for the same user, and a different one for another', () => {
    expect(nano.agentAddressFor(A)).toBe(nano.agentAddressFor(A));
    expect(nano.agentAddressFor(A.toLowerCase() as `0x${string}`)).toBe(nano.agentAddressFor(A));
    expect(nano.agentAddressFor(A)).not.toBe(nano.agentAddressFor(B));
  });

  it('is never the user’s own address', () => {
    expect(nano.agentAddressFor(A).toLowerCase()).not.toBe(A.toLowerCase());
  });
});

describe('API key', () => {
  it('names its user and round-trips', () => {
    expect(nano.userForToken(nano.tokenFor(A))).toBe(A);
  });

  it('cannot be moved to another user by editing the address in it', () => {
    const forged = nano.tokenFor(A).replace(A.slice(2).toLowerCase(), B.slice(2).toLowerCase());
    expect(() => nano.userForToken(forged)).toThrow(/invalid API key/);
  });

  it('refuses anything that is not a key', () => {
    expect(() => nano.userForToken(undefined)).toThrow(/missing or malformed/);
    expect(() => nano.userForToken('sk-ant-123')).toThrow(/missing or malformed/);
  });
});
