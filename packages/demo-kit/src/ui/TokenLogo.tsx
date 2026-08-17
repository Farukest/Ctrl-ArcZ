import type { TokenInfo } from '@ctrl-arcz/sdk';

/**
 * A token's mark.
 *
 * Resolved from `./token-logos/<SYMBOL>.svg` first, the same way `ChainLogo`
 * resolves networks, so dropping an official asset in is all it takes to use one.
 *
 * Nothing is in there yet, and what is drawn below is deliberately not an attempt
 * at Circle's logo. Copying a brand mark from memory produces a wrong-looking one,
 * and a wrong-looking badge next to a real balance is worse than an honest
 * generic: a token badge is the thing people glance at to check they are sending
 * the right asset. So this is a coin in the token's own colour with its currency
 * sign, which is unmistakably ours and unmistakably that token.
 */
const logos = import.meta.glob('./token-logos/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/**
 * Ink that can be read on the coin it sits on.
 *
 * White on every tint was wrong the moment a light one arrived: white on cirBTC's
 * orange measured about 2:1, which the theme audit caught. Rather than hand-pick a
 * colour per token and get it wrong again on the next one, the glyph takes
 * whichever of black or white the background can carry.
 */
function inkFor(hex: string): string {
  const h = hex.replace('#', '');
  const to = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * to(0) + 0.7152 * to(2) + 0.0722 * to(4);
  // Contrast against white is (1.05 / (l + 0.05)); against black, (l + 0.05) / 0.05.
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#111418';
}

/** The glyph that says what the money is, rather than the first two letters of
 *  its ticker. Anything unlisted falls back to its initial. */
const GLYPHS: Record<string, string> = {
  USDC: '$',
  EURC: '€',
  cirBTC: '₿',
  USYC: '%',
};

export function TokenLogo({ token, size = 24 }: { token: TokenInfo; size?: number }) {
  const official = logos[`./token-logos/${token.symbol}.svg`];
  if (official) {
    return (
      <span
        className="tokenlogo"
        style={{ width: size, height: size }}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: official }}
      />
    );
  }

  const glyph = GLYPHS[token.symbol] ?? token.symbol.charAt(0).toUpperCase();
  return (
    <span
      className="tokenlogo tokenlogo--drawn"
      style={{
        width: size,
        height: size,
        // The token's own colour, so a row is identifiable before it is read.
        background: token.tint,
        color: inkFor(token.tint),
        fontSize: Math.round(size * 0.52),
      }}
      aria-hidden
    >
      {glyph}
    </span>
  );
}
