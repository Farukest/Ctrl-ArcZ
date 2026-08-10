/**
 * A merchant somebody might pay by subscription.
 *
 * A name and a mark, nothing else. Deliberately not an address: who these companies
 * are is general knowledge, and where they take payment on a testnet is not
 * something this app can know or should pretend to. The address stays the field it
 * always was. This only answers "what is this subscription called", which used to be
 * typed and mistyped.
 *
 * Marks come from simple-icons (CC0), inlined the same way network logos are: an SVG
 * per key under ./merchant-logos, resolved by a glob, so adding a merchant is a file
 * rather than an edit here. A brand's own colour is baked into the file where it
 * survives our background, and the near-white every other mono glyph uses where it
 * does not.
 */
const logos = import.meta.glob('./merchant-logos/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

export type Merchant = { key: string; name: string };

/**
 * The list offered, in the order it is shown.
 *
 * Fixed rather than fetched. A picker that reaches the network to draw itself is a
 * picker that is empty on a bad connection, and this one is chrome on a form somebody
 * is trying to fill in. Kept in the same order as the Android client's list so the
 * two apps offer the same thing in the same place.
 */
export const MERCHANTS: readonly Merchant[] = [
  { key: 'netflix', name: 'Netflix' },
  { key: 'spotify', name: 'Spotify' },
  { key: 'youtube', name: 'YouTube' },
  { key: 'primevideo', name: 'Prime Video' },
  { key: 'openai', name: 'OpenAI' },
  { key: 'adobe', name: 'Adobe' },
  { key: 'figma', name: 'Figma' },
  { key: 'notion', name: 'Notion' },
  { key: 'canva', name: 'Canva' },
  { key: 'github', name: 'GitHub' },
  { key: 'jetbrains', name: 'JetBrains' },
  { key: 'vercel', name: 'Vercel' },
  { key: 'cloudflare', name: 'Cloudflare' },
  { key: 'digitalocean', name: 'DigitalOcean' },
  { key: 'dropbox', name: 'Dropbox' },
  { key: 'twitch', name: 'Twitch' },
  { key: 'steam', name: 'Steam' },
  { key: 'playstation', name: 'PlayStation' },
  { key: 'patreon', name: 'Patreon' },
  { key: 'substack', name: 'Substack' },
  { key: 'medium', name: 'Medium' },
  { key: 'audible', name: 'Audible' },
  { key: 'coursera', name: 'Coursera' },
  { key: 'udemy', name: 'Udemy' },
  { key: 'duolingo', name: 'Duolingo' },
  { key: 'linkedin', name: 'LinkedIn' },
  { key: 'nordvpn', name: 'NordVPN' },
  { key: 'namecheap', name: 'Namecheap' },
  { key: 'godaddy', name: 'GoDaddy' },
  { key: 'hey', name: 'HEY' },
] as const;

/** The merchant a typed or announced name refers to, if the list knows it. */
export function merchantByName(name: string): Merchant | undefined {
  const n = name.trim().toLowerCase();
  return n ? MERCHANTS.find((m) => m.name.toLowerCase() === n) : undefined;
}

/**
 * The mark, on the neutral tile every logo in this app sits on.
 *
 * A name with no match still gets a tile rather than nothing, so a custom
 * subscription lines up with the rest of the list instead of sitting half an inch to
 * the left of it.
 */
export function MerchantLogo({ name, size = 22 }: { name: string; size?: number }) {
  const merchant = merchantByName(name);
  const svg = merchant ? logos[`./merchant-logos/${merchant.key}.svg`] : undefined;
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
      {name.trim().slice(0, 2).toUpperCase() || '?'}
    </span>
  );
}
