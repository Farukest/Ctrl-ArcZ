import { describe, it, expect } from 'vitest';
import {
  CCTP_CHAINS,
  ADDRESSES,
  ARC_TOKENS,
  tokensFor,
  spendableTokensFor,
  defaultTokenFor,
  ARC_TESTNET_CHAIN_ID,
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

const USDC_T = ARC_TOKENS[0] as (typeof ARC_TOKENS)[number];
const EURC = ARC_TOKENS[1] as (typeof ARC_TOKENS)[number];

const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** A chain that answers whatever the test says it answers. */
function chain(answers: Record<string, { symbol: string; decimals: number }>) {
  return async (address: `0x${string}`, selector: `0x${string}`) => {
    const a = answers[address.toLowerCase()];
    if (!a) throw new Error(`no contract at ${address}`);
    return selector === '0x313ce567' ? word(a.decimals) : encodeString(a.symbol);
  };
}

/** Answers exactly what each registry row claims, for every row there is. */
const honest = chain(
  Object.fromEntries(
    ARC_TOKENS.map((t) => [t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals }]),
  ),
);

describe('the Arc token registry', () => {
  it('defaults to USDC, which is also what gas is paid in', () => {
    expect(DEFAULT_TOKEN.symbol).toBe('USDC');
    expect(DEFAULT_TOKEN.address).toBe(ADDRESSES.USDC);
  });

  it('lists USYC, but not as something that can be picked', () => {
    expect(ARC_TOKENS.map((t) => t.symbol)).toEqual(['USDC', 'EURC', 'cirBTC', 'USYC']);
    expect(tokenBySymbol('USYC')?.restricted?.reason).toBe('allowlist');
    expect(spendableTokensFor(ARC_TESTNET_CHAIN_ID).map((t) => t.symbol)).toEqual([
      'USDC',
      'EURC',
      'cirBTC',
    ]);
  });

  /**
   * The one the amount maths cares about. Everything here used to be six, which is
   * why "assume six" survived as long as it did; cirBTC is the token that makes a
   * wrong assumption cost a hundred times the intended payment.
   */
  it('carries cirBTC at eight decimals, not six', () => {
    expect(tokenBySymbol('cirBTC')?.decimals).toBe(8);
  });

  it('carries a name for every token, because a ticker is not a name', () => {
    for (const t of ARC_TOKENS) expect(t.name.length).toBeGreaterThan(3);
    expect(tokenBySymbol('cirBTC')?.name).toBe('Circle Wrapped BTC');
  });
});

describe('tokens are per chain', () => {
  it('answers for Arc', () => {
    expect(tokensFor(ARC_TESTNET_CHAIN_ID).length).toBe(4);
    expect(defaultTokenFor(ARC_TESTNET_CHAIN_ID)?.symbol).toBe('USDC');
  });

  /**
   * Not an oversight and not an empty state to fill in later: we have verified no
   * token addresses on a chain we do not deploy to, and a symbol resolved against
   * the wrong chain is a transfer to the wrong contract. Nothing is the honest
   * answer, and it stays nothing rather than falling back to Arc's list.
   */
  it('offers nothing on a chain we have verified nothing for', () => {
    expect(tokensFor(1)).toEqual([]);
    expect(tokensFor(undefined)).toEqual([]);
    expect(defaultTokenFor(1)).toBeUndefined();
  });

  /**
   * USDC and only USDC on the chains deployed alongside Arc.
   *
   * The shortness is the point. USDC's address on each was read off Circle's own
   * published table; EURC and cirBTC exist on some of them at addresses nobody has
   * verified, and an unverified address in a picker is how money reaches a
   * lookalike. The entry has to exist at all, though: without one,
   * `defaultTokenFor` answers nothing and the screen falls back to Arc's USDC,
   * which on Base is not a token.
   */
  it('offers verified USDC on each deployed chain', () => {
    for (const chain of ['Base_Sepolia', 'Ethereum_Sepolia', 'Arbitrum_Sepolia', 'Avalanche_Fuji'] as const) {
      const id = CCTP_CHAINS[chain].chainId;
      const tokens = tokensFor(id);
      expect(tokens.map((t) => t.symbol)).toEqual(['USDC']);
      expect(tokens[0]!.address.toLowerCase()).toBe(CCTP_CHAINS[chain].usdc.toLowerCase());
      expect(tokens[0]!.decimals).toBe(6);
      expect(defaultTokenFor(id)?.address.toLowerCase()).toBe(
        CCTP_CHAINS[chain].usdc.toLowerCase(),
      );
    }
  });

  it('scopes a lookup to the chain when it is given one', () => {
    expect(tokenBySymbol('EURC', ARC_TESTNET_CHAIN_ID)?.address).toBe(ADDRESSES.EURC);
    expect(tokenBySymbol('EURC', 84532)).toBeUndefined();
    expect(tokenByAddress(ADDRESSES.EURC, 84532)).toBeUndefined();
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
    const r = await verifyToken(lying, EURC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('18');
      expect(r.reason).toContain('not 6');
    }
  });

  it('refuses an address that calls itself something else', async () => {
    const impostor = chain({ [ADDRESSES.EURC.toLowerCase()]: { symbol: 'EURD', decimals: 6 } });
    const r = await verifyToken(impostor, EURC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('does not call itself EURC');
  });

  /** An RPC that cannot be reached is not a verdict about the token. */
  it('reports an unreachable chain as a reason rather than throwing', async () => {
    const dead = async () => {
      throw new Error('request limit reached');
    };
    const r = await verifyToken(dead, USDC_T);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('request limit');
  });
});
