import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { getCleanHistory } from '../src/history/history.js';
import { ADDRESSES } from '../src/chains/arcTestnet.js';

const ME = '0x1111111111111111111111111111111111111111' as Address;
const REAL = '0x3A5f8b2c9d1e4f6a7b8c9d0e1f2a3b4c5d6e9C2b' as Address;
const POISONER = '0x3A5f0000000000000000000000000000000009C2b'.slice(0, 42) as Address;
const SCAM_TOKEN = '0xdead000000000000000000000000000000000000' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function transfer(overrides: Record<string, unknown>) {
  return {
    transaction_hash: '0xabc',
    timestamp: '2026-07-11T10:00:00.000000Z',
    from: { hash: ME },
    to: { hash: REAL },
    total: { value: '5000000', decimals: '6' },
    // The shape the explorer actually serves today. The fixture used to say
    // `address`, which is why this suite stayed green while the live history was
    // empty for every wallet.
    token: { address_hash: ADDRESSES.USDC, symbol: 'USDC', decimals: '6' },
    ...overrides,
  };
}

function fakeFetch(items: unknown[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('getCleanHistory', () => {
  it('keeps a real USDC transfer', async () => {
    const history = await getCleanHistory(ME, { fetchFn: fakeFetch([transfer({})]) });

    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.amount).toBe(5_000_000n);
    expect(history.entries[0]?.direction).toBe('out');
    expect(history.filtered).toHaveLength(0);
  });

  /** The bait itself: a 0-value transfer whose only job is to enter this list. */
  it('filters the 0-value transfer a poisoner sent', async () => {
    const history = await getCleanHistory(ME, {
      fetchFn: fakeFetch([
        transfer({}),
        transfer({
          transaction_hash: '0xbait',
          from: { hash: POISONER },
          to: { hash: ME },
          total: { value: '0', decimals: '6' },
        }),
      ]),
    });

    expect(history.entries).toHaveLength(1);
    expect(history.entries.map((e) => e.txHash)).not.toContain('0xbait');

    expect(history.filtered).toHaveLength(1);
    expect(history.filtered[0]?.reason).toBe('ZERO_VALUE');
    expect(history.filtered[0]?.counterparty).toBe(POISONER);
  });

  it('filters a lookalike token nobody asked for', async () => {
    const history = await getCleanHistory(ME, {
      fetchFn: fakeFetch([
        transfer({
          transaction_hash: '0xscam',
          from: { hash: POISONER },
          to: { hash: ME },
          total: { value: '1000000', decimals: '6' },
          token: { address_hash: SCAM_TOKEN, symbol: 'USDC', decimals: '6' },
        }),
      ]),
    });

    expect(history.entries).toHaveLength(0);
    expect(history.filtered[0]?.reason).toBe('UNKNOWN_TOKEN');
  });

  it('hides rather than destroys — the spam is still inspectable', async () => {
    const history = await getCleanHistory(ME, {
      fetchFn: fakeFetch([transfer({ total: { value: '0', decimals: '6' } })]),
    });

    expect(history.entries).toHaveLength(0);
    expect(history.filtered).toHaveLength(1);
    expect(history.filtered[0]?.txHash).toBe('0xabc');
  });

  it('marks direction from the perspective of the queried address', async () => {
    const history = await getCleanHistory(ME, {
      fetchFn: fakeFetch([transfer({ from: { hash: REAL }, to: { hash: ME } })]),
    });

    expect(history.entries[0]?.direction).toBe('in');
    expect(history.entries[0]?.counterparty).toBe(REAL);
  });

  it('accepts a custom token allowlist', async () => {
    const history = await getCleanHistory(ME, {
      allowedTokens: [SCAM_TOKEN],
      fetchFn: fakeFetch([
        transfer({ token: { address_hash: SCAM_TOKEN, symbol: 'X', decimals: '18' } }),
      ]),
    });

    expect(history.entries).toHaveLength(1);
  });

  it('raises when the explorer fails, rather than pretending the history is empty', async () => {
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;

    await expect(getCleanHistory(ME, { fetchFn: failing })).rejects.toThrow(/503/);
  });
  it('still reads the legacy `address` field, for an older explorer build', async () => {
    const legacy = {
      ...transfer({}),
      token: { address: ADDRESSES.USDC, symbol: 'USDC', decimals: '6' },
    };
    const history = await getCleanHistory(ME, { fetchFn: fakeFetch([legacy]) });

    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.tokenAddress).toBe(ADDRESSES.USDC);
  });

  it('does not silently swallow a row whose token address is missing entirely', async () => {
    const noToken = { ...transfer({}), token: { symbol: 'USDC', decimals: '6' } };
    const history = await getCleanHistory(ME, { fetchFn: fakeFetch([noToken]) });

    // Unidentifiable token, so it cannot be allowlisted; it belongs in `filtered`
    // where the user can still see it, never dropped on the floor.
    expect(history.entries).toHaveLength(0);
    expect(history.filtered).toHaveLength(1);
    expect(history.filtered[0]?.reason).toBe('UNKNOWN_TOKEN');
  });

  // A mint has no sender, so the explorer serves 0x0000...0000 and the row read
  // "received from 0x0000...0000": paid by nobody. On Arc that row is almost always
  // the holder's own money arriving over a bridge, so `kind` has to say so.
  describe('a row with no counterparty', () => {
    const bridged = (method: string) =>
      transfer({ from: { hash: ZERO }, to: { hash: ME }, method, transaction_hash: '0xmint' });

    it('marks a CCTP arrival as a mint, not a transfer from nobody', async () => {
      const history = await getCleanHistory(ME, {
        fetchFn: fakeFetch([bridged('receiveMessage')]),
      });

      const entry = history.entries[0];
      expect(entry?.kind).toBe('mint');
      expect(entry?.method).toBe('receiveMessage');
      expect(entry?.direction).toBe('in');
    });

    it('marks a Gateway arrival the same way, told apart by its method', async () => {
      const history = await getCleanHistory(ME, { fetchFn: fakeFetch([bridged('gatewayMint')]) });

      expect(history.entries[0]?.kind).toBe('mint');
      expect(history.entries[0]?.method).toBe('gatewayMint');
    });

    it('marks a burn from the other side', async () => {
      const history = await getCleanHistory(ME, {
        fetchFn: fakeFetch([transfer({ from: { hash: ME }, to: { hash: ZERO } })]),
      });

      expect(history.entries[0]?.kind).toBe('burn');
      expect(history.entries[0]?.direction).toBe('out');
    });

    it('leaves an ordinary transfer alone, with no method to report', async () => {
      const history = await getCleanHistory(ME, { fetchFn: fakeFetch([transfer({})]) });

      expect(history.entries[0]?.kind).toBe('transfer');
      expect(history.entries[0]?.method).toBeNull();
    });

    // The zero address is derived from the addresses, not from the indexer's own
    // `type` string, so a mislabelled or absent type cannot turn a mint into a
    // payment from 0x0000...0000.
    it('does not take the indexer word for it', async () => {
      const history = await getCleanHistory(ME, {
        fetchFn: fakeFetch([
          transfer({ from: { hash: ZERO }, to: { hash: ME }, type: 'token_transfer' }),
        ]),
      });

      expect(history.entries[0]?.kind).toBe('mint');
    });
  });
});
