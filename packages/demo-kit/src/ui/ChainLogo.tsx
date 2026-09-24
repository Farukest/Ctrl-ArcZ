/**
 * Real network logo, resolved dynamically. Brand SVGs live in ./chain-logos as
 * `<ChainId>.svg` and are pulled in with a glob, so adding a chain is a matter of
 * dropping in a file, not editing a map here. The SVG is inlined (no external
 * request, CSP-safe, crisp at any size) on a white token so every brand, even the
 * mono/dark ones, stays legible on the dark theme.
 */
import { CCTP_CHAINS, type CctpChainName } from '@ctrl-arcz/sdk';

const logos = import.meta.glob('./chain-logos/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/**
 * The file a chain's mark is filed under.
 *
 * The marks are filed under the testnet names they were first drawn for. A
 * mainnet is the same brand, and Circle gives both halves of a pair the same CCTP
 * domain, so a mainnet with no file of its own borrows its testnet's.
 */
export function logoIdFor(id: string): string {
  if (logos[`./chain-logos/${id}.svg`]) return id;
  const chain = CCTP_CHAINS[id as CctpChainName];
  if (!chain || chain.testnet) return id;
  const sibling = (Object.keys(CCTP_CHAINS) as CctpChainName[]).find(
    (n) => CCTP_CHAINS[n].testnet && CCTP_CHAINS[n].domain === chain.domain,
  );
  return sibling ?? id;
}

function svgFor(id: string): string | undefined {
  return logos[`./chain-logos/${logoIdFor(id)}.svg`];
}

export function ChainLogo({ id, size = 20 }: { id: string; size?: number }) {
  const svg = svgFor(id);
  if (svg) {
    return (
      <span
        className="chainlogo"
        style={{ width: size, height: size }}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <span
      className="chainlogo chainlogo--fallback"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {id.replace(/_.*/, '').slice(0, 2).toUpperCase()}
    </span>
  );
}
