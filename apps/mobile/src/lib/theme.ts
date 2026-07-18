// Shared visual tokens, matching the web apps and docs (amber on near-black).
export const theme = {
  bg: '#0b0b0f',
  card: '#15151c',
  cardBorder: '#26262f',
  text: '#f5f5f7',
  muted: '#9a9aa5',
  primary: '#f5a524',
  primaryText: '#0b0b0f',
  safe: '#3fb950',
  warning: '#f5a524',
  block: '#f85149',
  radius: 14,
  sp: (n: number) => n * 4,
} as const;

export type Theme = typeof theme;
