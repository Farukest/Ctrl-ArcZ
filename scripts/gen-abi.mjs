/**
 * Generates `packages/sdk/src/abi/ctrlArcZ.ts` from the Foundry build artifact.
 *
 * The ABI is never hand-copied: it is derived from the compiled contract, so it
 * cannot drift from the Solidity. Run `pnpm --filter @ctrl-arcz/contracts build`
 * first; `pnpm gen:abi` at the root does both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const artifacts = [
  { name: 'ctrlArcZAbi', file: 'packages/contracts/out/CtrlArcZ.sol/CtrlArcZ.json' },
  {
    name: 'codeClaimVerifierAbi',
    file: 'packages/contracts/out/CodeClaimVerifier.sol/CodeClaimVerifier.json',
  },
];

let out = `/**
 * GENERATED FILE — do not edit.
 * Source: packages/contracts/out/**, produced by \`pnpm gen:abi\`.
 */\n\n`;

for (const { name, file } of artifacts) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Artifact missing: ${file} — run \`forge build\` in packages/contracts first.`);
  }
  const { abi } = JSON.parse(fs.readFileSync(full, 'utf8'));
  out += `export const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n\n`;
}

// The Memo predeploy is Arc's, not ours: its ABI is transcribed from the Arc docs
// (https://docs.arc.io/arc/tutorials/send-usdc-with-transaction-memo), which is the source.
out += `/**
 * Arc's Memo predeploy.
 * Source: https://docs.arc.io/arc/tutorials/send-usdc-with-transaction-memo
 * Callable only by an EOA: a contract caller reverts as sender spoofing, which is why
 * CtrlArcZ wraps the send from the SDK instead of calling Memo itself.
 */
export const memoAbi = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Memo',
    anonymous: false,
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'target', type: 'address', indexed: true },
      { name: 'callDataHash', type: 'bytes32', indexed: false },
      { name: 'memoId', type: 'bytes32', indexed: true },
      { name: 'memo', type: 'bytes', indexed: false },
      { name: 'memoIndex', type: 'uint256', indexed: false },
    ],
  },
] as const;
`;

const outPath = path.join(root, 'packages/sdk/src/abi/ctrlArcZ.ts');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`abi/ctrlArcZ.ts yazildi (${artifacts.map((a) => a.name).join(', ')}, memoAbi)`);
