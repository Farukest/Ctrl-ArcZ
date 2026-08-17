import { describe, it, expect } from 'vitest';
import {
  ADDRESSES,
  ARC_TOKENS,
  DEFAULT_TOKEN,
  tokenByAddress,
  tokenBySymbol,
  verifyToken,
} from '../src/index.js';

/** ABI-encode a `string` return, the way an ERC-20 `symbol()` call comes back. */
function encodeString(s: string): string {
  const bytes = [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
  return `0x${(32).toString(16).padStart(64, '0')}${s.length.toString(16).padStart(64, '0')}${padded}`;
}

const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** A chain that answers whatever the test says it answers. */
function chain(answers: Record<string, { symbol: string; decimals: number }>) {
  return async (address: `0x${string}`, selector: `0x${string}`) => {
    const a = answers[address.toLowerCase()];
    if (!a) throw new Error(`no contract at ${address}`);
    return selector === '0x313ce567' ? word(a.decimals) : encodeString(a.symbol);
  };
}

const honest = chain({
  [ADDRESSES.USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
  [ADDRESSES.EURC.toLowerCase()]: { symbol: 'EURC', decimals: 6 },
});

describe('the Arc token registry', () => {
  it('defaults to USDC, which is also what gas is paid in', () => {
    expect(DEFAULT_TOKEN.symbol).toBe('USDC');
    expect(DEFAULT_TOKEN.address).toBe(ADDRESSES.USDC);
  });

  it('does not list USYC, which is permissioned', () => {
    expect(ARC_TOKENS.map((t) => t.symbol)).toEqual(['USDC', 'EURC']);
  });

  it('looks a token up by address case-insensitively, since addresses arrive both ways', () => {
    expect(tokenByAddress(ADDRESSES.EURC.toUpperCase())?.symbol).toBe('EURC');
    expect(tokenByAddress(ADDRESSES.EURC.toLowerCase())?.symbol).toBe('EURC');
    expect(tokenByAddress('0x000000000000000000000000000000000000dead')).toBeUndefined();
  });

  it('looks a token up by symbol', () => {
    expect(tokenBySymbol('usdc')?.address).toBe(ADDRESSES.USDC);
    expect(tokenBySymbol('DAI')).toBeUndefined();
  });

  it('carries search words the contracts do not, because name() returns the symbol', () => {
    expect(tokenBySymbol('EURC')?.searchNames).toContain('euro');
    expect(tokenBySymbol('USDC')?.searchNames).toContain('dollar');
  });
});

describe('verifyToken', () => {
  it('agrees with a chain that matches the registry', async () => {
    for (const t of ARC_TOKENS) {
      expect(await verifyToken(honest, t)).toEqual({ ok: true });
    }
  });

  /**
   * The one that matters. Decimals are what the amount maths multiplies by, so a
   * registry that says 6 against a token that says 18 is not a display bug, it is
   * sending a millionth of what the user typed. The caller is meant to drop the
   * token on a false, not log and carry on.
   */
  it('refuses a token whose decimals disagree, and says both numbers', async () => {
    const lying = chain({ [ADDRESSES.EURC.toLowerCase()]: { symbol: 'EURC', decimals: 18 } });
    const r = await verifyToken(lying, ARC_TOKENS[1]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('18');
      expect(r.reason).toContain('not 6');
    }
  });

  it('refuses an address that calls itself something else', async () => {
    const impostor = chain({ [ADDRESSES.EURC.toLowerCase()]: { symbol: 'EURD', decimals: 6 } });
    const r = await verifyToken(impostor, ARC_TOKENS[1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('does not call itself EURC');
  });

  /** An RPC that cannot be reached is not a verdict about the token. */
  it('reports an unreachable chain as a reason rather than throwing', async () => {
    const dead = async () => {
      throw new Error('request limit reached');
    };
    const r = await verifyToken(dead, ARC_TOKENS[0]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('request limit');
  });
});
