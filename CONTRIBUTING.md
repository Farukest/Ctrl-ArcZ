# Contributing

Thanks for looking. This is a small repository with a large surface: one contract,
one published SDK, a web app, a backend and a keeper. The notes below are the parts
that are not obvious from reading the tree.

## Getting a working checkout

```bash
git clone --recurse-submodules https://github.com/Farukest/Ctrl-ArcZ.git
cd Ctrl-ArcZ
pnpm install
```

`--recurse-submodules` is not optional. `forge-std` and `openzeppelin-contracts` are
pinned submodules, and without them `forge build` cannot resolve a single import. If
you have already cloned without it, `git submodule update --init --recursive`.

You need Node 20 or newer, pnpm (the version in `packageManager` is what CI uses)
and [Foundry](https://book.getfoundry.sh/) for the contracts.

## Before you open a pull request

These four are what CI runs, in this order, and they are the whole gate:

```bash
pnpm --filter @ctrl-arcz/sdk build   # the SDK is consumed through dist, so build it first
pnpm lint
pnpm typecheck
pnpm -r test
```

`pnpm -r test` runs Foundry, the SDK, demo-kit, the API and the keeper. It touches no
network and needs no keys: the integration tests are excluded unless `INTEGRATION=1`,
and running those needs funded testnet wallets you have to provide yourself.

`pnpm format:check` is **not** part of the gate. Prettier disagrees with a number of
hand-formatted files and running `pnpm format` across the repository would produce a
diff nobody wants to review. Format the files you touched, not the ones you did not.

## Things that will bite you

**Addresses live in one file.** Every address, RPC and chain constant is in
`packages/sdk/src/chains/arcTestnet.ts`. The Foundry deploy script reads a JSON file
generated from it. If you find yourself typing an address into a second place, that
is the bug.

**The parity vectors are generated, not written.** `packages/sdk/parity-vectors.json`
comes from `packages/sdk/scripts/gen-parity-vectors.ts`, and a test fails if the
committed file is not what the code currently produces. Change `claimCode.ts` or
`stealth.ts` and you must regenerate it, because a second implementation asserts
against that file. See [docs/android](./docs/android/overview.mdx).

**Never commit an `.env`.** `.env`, `.env.*` and `*.pem` / `*.key` are ignored, and
so are a few files that hold throwaway private keys in the clear. Stage the files you
changed by name rather than reaching for `git add -A`. `.env.example` is the one that
belongs in the repository.

**Contracts are unowned by design.** `CtrlArcZ` has no owner, no pause, no proxy and
no upgrade path. A change that adds an admin function is not a small change, and it
needs to be argued for in the pull request rather than slipped in.

## Tests

New behaviour needs a test, and the useful question is not "does this pass" but
"would this fail if the behaviour came back". Where a test guards something that was
once broken, say so in the test name or a comment. Several already do, and that is
why they survive refactors.

Contract tests are Foundry (`packages/contracts/test`), everything else is Vitest.
`pnpm --filter @ctrl-arcz/contracts coverage` reports contract coverage.

## Commits

One change per commit, an imperative subject line, and a body that explains why
rather than what. The diff already says what. `git log` is the house style; follow
whatever you find there.

## Security

Do not open a public issue for a vulnerability. `SECURITY.md` documents the current
threat model and the review that has already been done; read it before reporting, and
contact the maintainer directly for anything that would put funds at risk.

Everything here is Arc Testnet and the contract has not been audited.
