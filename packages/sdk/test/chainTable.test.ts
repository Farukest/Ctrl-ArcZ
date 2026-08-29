import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS, and deliberately outside src: it imports the Circle
// kit, which is a devDependency that must never reach a bundle.
import { deriveChains, OUR_NAME, RESELLERS } from '../scripts/derive-chains.mjs';
import {
  GENERATED_CHAINS,
  type GeneratedChain,
} from '../src/chains/circleChains.generated.js';
import {
  CCTP_CHAINS,
  GATEWAY_CHAIN_NAMES,
  firstPartyRpc,
  readRpcUrls,
  type CctpChainName,
} from '../src/index.js';

/**
 * The checked-in chain table against the one Circle ships.
 *
 * `circleChains.generated.ts` exists so that nothing under `src/` has to import
 * `@circle-fin/bridge-kit`: three megabytes of Solana web3, ethers and pino, for a
 * table. The cost of a generated file is that it can go stale silently, and this is
 * what stops it. Bump the kit, forget to run the generator, and this fails with the
 * exact rows that moved.
 *
 * It is also the only test here that fails for a legitimate reason: Circle adding a
 * network is not a bug. Run `node scripts/generate-chains.mjs`, read the diff, and
 * check that anything new arrives with the facts the app needs.
 */
describe('the generated chain table', () => {
  const derived = deriveChains();

  it('is exactly what the installed kit says', () => {
    // Whole-object equality rather than field by field: a new field appearing in
    // Circle's data should show up here as a diff to look at, not be skipped
    // because nobody thought to assert it.
    expect(JSON.parse(JSON.stringify(GENERATED_CHAINS))).toEqual(derived);
  });

  it('renames only the three chains it means to', () => {
    /*
     * Our names, not Circle's, for three of them. They are the same chains by chain
     * id, domain and USDC address; the names differ because ours came from Circle's
     * CCTP references and theirs from the App Kit enum.
     *
     * Kept rather than harmonised because these strings are written into stored
     * activity rows in people's browsers. Renaming them orphans a user's history,
     * which is a real cost paid for a tidier table.
     */
    const renamed = GENERATED_CHAINS.filter((c) => 'circleName' in c);
    expect(Object.fromEntries(renamed.map((c) => [c.circleName, c.name]))).toEqual(OUR_NAME);
  });
});

/**
 * What the table has to be true of, whatever Circle puts in it.
 *
 * The one above pins the copy to the source. These pin the properties the app
 * relies on, so that a chain arriving from Circle with something missing fails here
 * rather than three screens away.
 */
describe('every chain in it can actually be used', () => {
  /*
   * The declared shape rather than the literal one. `as const` gives each row its
   * own type, and a row that happens to have no `firstPartyRpc` then has no such
   * property to read, which makes "check the optional field on every row" a type
   * error rather than the loop it obviously is.
   */
  const rows: readonly GeneratedChain[] = GENERATED_CHAINS;

  it('can be read, all of them', () => {
    // A chain in a picker whose balance cannot be read is a blank where a number
    // belongs. Circle publishes an endpoint for everything it serves, so this
    // holds by construction and this test is what says so out loud.
    for (const chain of GATEWAY_CHAIN_NAMES) {
      expect(readRpcUrls(CCTP_CHAINS[chain].chainId).length, chain).toBeGreaterThan(0);
    }
  });

  it('keeps chain ids and domains unique', () => {
    // Two chains sharing either would make a route ambiguous, and the failure would
    // be a transfer arriving somewhere else rather than an error.
    const ids = rows.map((c) => c.chainId);
    const domains = rows.map((c) => c.domain);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it('never calls a reseller the chain’s own endpoint', () => {
    // The filter that decides what may be written into a wallet, checked against
    // its own list rather than trusted. See addChain.test.ts for why it matters.
    for (const c of rows) {
      if (!c.firstPartyRpc) continue;
      const host = new URL(c.firstPartyRpc).host;
      for (const reseller of RESELLERS as string[]) {
        expect(host === reseller || host.endsWith(`.${reseller}`), `${c.name}: ${host}`).toBe(false);
      }
      // Widened above, so the name is a plain string here; it is one of these by
      // construction, which is what the equality on the next line is checking.
      expect(firstPartyRpc(c.name as CctpChainName)).toBe(c.firstPartyRpc);
    }
  });

  it('builds a working transaction link wherever it has an explorer', () => {
    /*
     * The template is kept whole for a reason. Most chains put a transaction under
     * `/tx/`, Injective uses `/transaction/`, and X Layer nests it under a per-chain
     * path, so the old approach -- keep a front page, glue `/tx/` on -- produced two
     * links that went nowhere.
     */
    for (const c of rows) {
      if (!c.explorerTx) continue;
      expect(c.explorerTx, c.name).toContain('{hash}');
      expect(c.explorerTx.replace('{hash}', '0xabc'), c.name).toMatch(/^https:\/\/\S+0xabc$/);
      // The front page has to be a prefix of the link, or one of the two is wrong.
      if (c.explorerUrl) expect(c.explorerTx.startsWith(`${c.explorerUrl}/`), c.name).toBe(true);
    }
  });
});
