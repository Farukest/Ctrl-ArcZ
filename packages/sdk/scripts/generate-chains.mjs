/**
 * Rewrites `src/chains/circleChains.generated.ts` from Circle's own chain table.
 *
 *     node scripts/generate-chains.mjs
 *
 * Everything this app knew about Circle's testnets used to be typed out by hand:
 * the CCTP domain, the chain id, the USDC address, which chains Gateway serves,
 * what each pays gas in, where its explorer is and what endpoint answers it. Every
 * one of those was checked against the chain when it was written, and every one was
 * correct -- when this moved to Circle's table, all twenty rows matched exactly.
 * What hand-typing could not do was notice Circle adding a network, and five had
 * been added by the time anybody looked.
 *
 * `@circle-fin/bridge-kit` publishes all of it, so this reads it there instead. The
 * kit is a devDependency and is never imported at runtime: three megabytes that drag
 * in Solana web3, ethers and pino, none of which belongs in a browser bundle for
 * what amounts to a table. So the table is generated into source, reviewed in the
 * diff like anything else, and `chainTable.test.ts` fails if the checked-in file and
 * the installed kit ever disagree.
 *
 * The derivation itself is in `derive-chains.mjs`, shared with that test.
 *
 * What stays ours, because Circle does not publish it:
 *
 *   - `gasToken: 'usdc'` on Arc. It is the only chain that bills gas in the token
 *     being moved, which changes what "can afford this" means rather than
 *     decorating it.
 *   - The extra read endpoints in `READ_RPCS`. Circle lists one or two per chain;
 *     this app probed more, and a second endpoint is what stops one throttled
 *     provider blanking a balance.
 *   - The Gateway deposit waits and base fees, which live in the Gateway docs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deriveChains } from './derive-chains.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const kitVersion = JSON.parse(
  readFileSync(join(here, '..', 'node_modules', '@circle-fin', 'bridge-kit', 'package.json'), 'utf8'),
).version;

const chains = deriveChains();
const q = (s) => `'${s}'`;
const out = [];

out.push(`/**`);
out.push(` * Circle's testnets, generated. Do not edit.`);
out.push(` *`);
out.push(` * Written by \`scripts/generate-chains.mjs\` out of \`@circle-fin/bridge-kit\`, which`);
out.push(` * is the same table Circle's own App Kit answers \`getSupportedChains\` from. Run the`);
out.push(` * script after bumping that dependency; \`chainTable.test.ts\` fails if this file and`);
out.push(` * the installed kit disagree, so the two cannot drift quietly.`);
out.push(` *`);
out.push(` * Generated from @circle-fin/bridge-kit@${kitVersion}.`);
out.push(` */`);
out.push(``);
out.push(`/** One of Circle's testnets, as much of it as this app has any use for. */`);
out.push(`export interface GeneratedChain {`);
out.push(`  /** This project's name for it, which is Circle's except for three aliases. */`);
out.push(`  readonly name: string;`);
out.push(`  /** Circle's own name, where it differs. Undefined when the two agree. */`);
out.push(`  readonly circleName?: string;`);
out.push(`  /** CCTP domain id. Not a chain id; the two are unrelated numbers. */`);
out.push(`  readonly domain: number;`);
out.push(`  readonly chainId: number;`);
out.push('  readonly usdc: `0x${string}`;');
out.push(`  /** True where Circle runs Gateway, which is a smaller set than CCTP. */`);
out.push(`  readonly gateway: boolean;`);
out.push(`  readonly nativeCurrency: {`);
out.push(`    readonly name: string;`);
out.push(`    readonly symbol: string;`);
out.push(`    readonly decimals: number;`);
out.push(`  };`);
out.push(`  /** The explorer's front page, or undefined where Circle publishes none. */`);
out.push(`  readonly explorerUrl?: string;`);
out.push(`  /** Circle's link template, with {hash} where the transaction hash goes. */`);
out.push(`  readonly explorerTx?: string;`);
out.push(`  /** Every endpoint Circle publishes, resellers included. For reading. */`);
out.push(`  readonly rpcEndpoints: readonly string[];`);
out.push(`  /**`);
out.push(`   * The chain's own endpoint, or undefined where it publishes none of its own.`);
out.push(`   * The only kind that may be written into a wallet.`);
out.push(`   */`);
out.push(`  readonly firstPartyRpc?: string;`);
out.push(`}`);
out.push(``);
out.push(`export const GENERATED_CHAINS = [`);

for (const c of chains) {
  out.push(`  {`);
  out.push(`    name: ${q(c.name)},`);
  if (c.circleName) out.push(`    circleName: ${q(c.circleName)},`);
  out.push(`    domain: ${c.domain},`);
  out.push(`    chainId: ${c.chainId},`);
  out.push(`    usdc: ${q(c.usdc)},`);
  out.push(`    gateway: ${c.gateway},`);
  out.push(
    `    nativeCurrency: { name: ${q(c.nativeCurrency.name)}, symbol: ${q(
      c.nativeCurrency.symbol,
    )}, decimals: ${c.nativeCurrency.decimals} },`,
  );
  if (c.explorerUrl) out.push(`    explorerUrl: ${q(c.explorerUrl)},`);
  if (c.explorerTx) out.push(`    explorerTx: ${q(c.explorerTx)},`);
  out.push(`    rpcEndpoints: [${c.rpcEndpoints.map(q).join(', ')}],`);
  if (c.firstPartyRpc) out.push(`    firstPartyRpc: ${q(c.firstPartyRpc)},`);
  out.push(`  },`);
}

out.push(`] as const satisfies readonly GeneratedChain[];`);
out.push('');

const target = join(here, '..', 'src', 'chains', 'circleChains.generated.ts');
writeFileSync(target, out.join('\n'), 'utf8');
console.log(`wrote ${chains.length} chains to ${target}`);
