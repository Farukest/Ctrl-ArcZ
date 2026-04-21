/**
 * Writes the freshly deployed CtrlArcZ address back into the single source of
 * truth (`packages/sdk/src/chains/arcTestnet.ts`), so the SDK and both demo apps
 * pick it up without anyone copy-pasting an address.
 *
 * Reads `packages/contracts/deployments/arc-testnet.json`, produced by Deploy.s.sol.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploymentPath = path.join(root, 'packages/contracts/deployments/arc-testnet.json');
const chainsPath = path.join(root, 'packages/sdk/src/chains/arcTestnet.ts');

if (!fs.existsSync(deploymentPath)) {
  throw new Error(`Deployment not found: ${deploymentPath} — run the deploy script first.`);
}

const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
const { CtrlArcZ, CodeClaimVerifier } = deployment;

if (!/^0x[0-9a-fA-F]{40}$/.test(CtrlArcZ ?? '')) {
  throw new Error(`Bad CtrlArcZ address in deployment: ${CtrlArcZ}`);
}

let ts = fs.readFileSync(chainsPath, 'utf8');

const before = ts;

// Tolerant of any whitespace/line breaks prettier may have introduced between the
// `=` and the address literal.
const replaceConst = (name, value) =>
  ts.replace(new RegExp(`(export const ${name} =\\s*)'0x[0-9a-fA-F]{40}'`), `$1'${value}'`);

ts = replaceConst('CTRL_ARCZ_ADDRESS', CtrlArcZ);
ts = replaceConst('CODE_CLAIM_VERIFIER_ADDRESS', CodeClaimVerifier);

// Event queries start at the deploy block (Arc caps eth_getLogs at 10k blocks).
if (deployment.deployBlock) {
  ts = ts.replace(/(export const CTRL_ARCZ_DEPLOY_BLOCK = )\d+n;/, `$1${deployment.deployBlock}n;`);
}

if (ts === before) {
  throw new Error('arcTestnet.ts was not updated — the address constants did not match.');
}

fs.writeFileSync(chainsPath, ts);
console.log(`arcTestnet.ts guncellendi:`);
console.log(`  CtrlArcZ          ${CtrlArcZ}`);
console.log(`  CodeClaimVerifier ${CodeClaimVerifier}`);
