/**
 * Real network logo, resolved dynamically. Brand SVGs live in ./chain-logos as
 * `<ChainId>.svg` and are pulled in with a glob, so adding a chain is a matter of
 * dropping in a file, not editing a map here. The SVG is inlined (no external
 * request, CSP-safe, crisp at any size) on a white token so every brand, even the
 * mono/dark ones, stays legible on the dark theme.
 */
const logos = import.meta.glob('./chain-logos/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function svgFor(id: string): string | undefined {
  return logos[`./chain-logos/${id}.svg`];
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
