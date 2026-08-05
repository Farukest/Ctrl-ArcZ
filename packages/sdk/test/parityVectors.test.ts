import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vectors } from '../scripts/gen-parity-vectors.js';

/**
 * The guard that makes `parity-vectors.json` worth anything.
 *
 * A second, independent implementation of this protocol exists in Kotlin, and it
 * asserts against that file. The obvious way to produce such a file is to dump it
 * once and copy it over, and that is the version that fails silently: change
 * `claimCode.ts` or `stealth.ts`, and the Kotlin side keeps passing against a
 * snapshot of behaviour this repo no longer has. Both suites stay green while the
 * two clients disagree on chain, which is where a user finds out.
 *
 * So the committed file is checked against freshly computed output on every run
 * here. Move the behaviour without regenerating and this goes red at home, before
 * anything reaches the other implementation.
 */
describe('parity vectors are current', () => {
  const committed = JSON.parse(
    readFileSync(join(__dirname, '..', 'parity-vectors.json'), 'utf8'),
  ) as typeof vectors;

  it('the committed file matches what the code produces right now', () => {
    // Whole-object equality on purpose. Field-by-field assertions would quietly
    // ignore anything added to the generator later, which is the failure mode that
    // matters: a new vector nobody notices is missing from the file the other
    // implementation reads.
    expect(committed).toEqual(vectors);
  });

  it('every vector is derived, never random', () => {
    // If any generator input reached a CSPRNG, this file would differ per run and
    // the check above would be noise that gets deleted rather than a signal.
    expect(JSON.parse(JSON.stringify(vectors))).toEqual(vectors);
  });
});

/**
 * The invariants an implementation has to satisfy, stated as properties rather than
 * as fixed strings. These are what the Kotlin port must also hold; the JSON pins the
 * exact values, and these say what the values mean.
 */
describe('parity vectors describe a working protocol', () => {
  it('a secret round-trips to a commitment the contract can verify', () => {
    for (const d of vectors.claim.commitments) {
      expect(d.salt).toMatch(/^0x[0-9a-f]{64}$/);
      expect(d.claimHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(d.salt).not.toBe(d.claimHash);
    }
  });

  it('mistyped secrets normalise, malformed ones are refused', () => {
    for (const n of vectors.claim.normalisation) expect(n.normalised).toHaveLength(16);
    for (const r of vectors.claim.rejected) expect(r.normalised).toBeNull();
  });

  it('the payer recovers every stealth address from the announcement alone', () => {
    // The whole point of the scheme: nothing on chain links the box to the payer,
    // so if this ever stops holding, the money is not lost but it is invisible.
    for (const a of vectors.stealth.addresses) {
      expect(a.recovered?.toLowerCase()).toBe(a.stealthAddress.toLowerCase());
      expect(a.ephemeralPubKey).toMatch(/^0x0[23][0-9a-f]{64}$/); // compressed secp256k1
      expect(a.viewTag).toBeGreaterThanOrEqual(0);
      expect(a.viewTag).toBeLessThan(256);
    }
  });

  it('a wrong view tag matches nothing', () => {
    expect(vectors.stealth.viewTagMismatch.matchedWithWrongTag).toBeNull();
  });

  it('every address is EIP-55 checksummed, and every stealth address too', () => {
    // The divergence the first cross-implementation run actually found: the SDK
    // renders checksummed, the Kotlin port rendered lowercase. The chain does not
    // care, and the one comparison that existed used ignoreCase, so nothing was
    // broken -- but the two clients were naming the same box differently, and
    // checksum is the typo protection a user relies on when reading an address off
    // a screen. Comparing the source constants would never have caught it: both
    // files held identical strings, only the rendered output differed.
    for (const [name, addr] of Object.entries(vectors.chain.addresses)) {
      expect(addr, name).toBe(getAddress(addr));
    }
    for (const a of vectors.stealth.addresses) {
      expect(a.stealthAddress).toBe(getAddress(a.stealthAddress));
      expect(a.recovered).toBe(getAddress(a.recovered!));
    }
  });

  it('the chain constants are the ones every client must agree on', () => {
    expect(vectors.chain.chainId).toBe(5042002);
    expect(vectors.chain.usdcDecimals).toBe(6);
    expect(vectors.chain.cctpDomain).toBe(26);
    // Arc caps an eth_getLogs range here; a client scanning wider gets -32614.
    expect(vectors.chain.maxLogRange).toBe(10000);
    expect(vectors.chain.deployBlocks.ctrlArcZ).toBeLessThan(
      vectors.chain.deployBlocks.stealthAnnouncer,
    );
  });

  it('the key-derivation message is byte-exact', () => {
    // One differing character yields different keys, and therefore a box one client
    // can see and the other cannot.
    expect(vectors.stealth.keyMessage).toBe(
      'Ctrl+ArcZ stealth keys v1\n\nSign to derive your private stealth keys. This does not cost gas and never moves funds.',
    );
    expect(vectors.stealth.schemeId).toBe(1);
  });
});
