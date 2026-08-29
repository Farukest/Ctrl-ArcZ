# Chain logos

One SVG per chain, named for this project's chain name (`Sonic_Testnet.svg`).
`ChainLogo` picks them up with a glob, so adding a network is a matter of dropping
a file in here. A chain with no file gets two letters on a token instead, which is
a real fallback and not a placeholder to be embarrassed about: it is what a brand
new network looks like until somebody publishes a mark for it.

## Where they come from

[`0xa3k5/web3icons`](https://github.com/0xa3k5/web3icons), MIT, from
`packages/core/src/svgs/networks/branded/`. Taken verbatim: the files here are
byte-identical to that repository's, which is how the source was confirmed rather
than assumed.

The mark is the **mainnet** brand for a chain we use on testnet, which is right and
deliberate. Circle's testnets are the same networks wearing a different chain id, and
Base Sepolia showing Base's mark is what a user expects.

Each file was matched to its chain by chain id rather than by a name that looked
close, because names are where this goes wrong: web3icons carries `edgeless`
(Edgeless Network, 2026) which is not Circle's EDGE. Most of the pairs turn out to be
neighbours, which is a good sign on its own: Sei 1328/1329, HyperEVM 998/999, Plume
98867/98866, Plasma 9746/9745, XDC 51/50.

`Injective_Testnet.svg` is the one taken on a name match: the icon is published but
the set carries no metadata row for it, so there was no chain id to check it against.
There is one Injective, so the risk is small, but it is a weaker basis than the rest
and is written down here rather than lost.

## What is deliberately missing

Three chains have no file and fall back to their initials, because no set publishes a
mark for them and inventing one is worse than two letters:

- **Edge Testnet** (33431). `edgeless` is a different network; nothing else carries it.
- **Morph Hoodi** (2910).
- **Pharos Testnet** (688689).

## Rules for anything added here

- 24x24 `viewBox`, so it sits on the same optical grid as the rest.
- No `<script>`, no external `href` or `url()`, no `<image>`: these are inlined into
  the page, and the app ships without a CSP precisely so the browser can reach
  Circle and the chains, not so an icon can reach anything.
- Unique `id` attributes. Every one of these ends up in one document, so two files
  sharing a gradient id means one logo quietly paints with the other's colours.

`chainLogos.test.ts` checks all four.
