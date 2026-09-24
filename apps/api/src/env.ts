import 'dotenv/config';
import type { Hex } from 'viem';

export const env = {
  port: Number(process.env.PORT) || 8787,
  cosignerPk: (process.env.COSIGNER_PK || undefined) as Hex | undefined,
  relayerPk: (process.env.RELAYER_PK || undefined) as Hex | undefined,
  /**
   * The relayer on mainnet chains. Its own key and its own balance, never the
   * testnet one: that key has lived in demo configs, and on mainnet the relayer's
   * balance is real money. Absent = every relayer-funded route refuses mainnet.
   */
  relayerPkMainnet: (process.env.RELAYER_PK_MAINNET || undefined) as Hex | undefined,
  /**
   * Alchemy, for chains whose history the firewall reads there (Arc mainnet).
   * Server-only; the browser reaches it through `/api/chain-data`.
   */
  alchemyApiKey: process.env.ALCHEMY_API_KEY || undefined,
  circleClientKey: process.env.CIRCLE_CLIENT_KEY || undefined,
  circleClientUrl: process.env.CIRCLE_CLIENT_URL || undefined,
  /** Enables the investigator. Absent = the feature is simply off. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
