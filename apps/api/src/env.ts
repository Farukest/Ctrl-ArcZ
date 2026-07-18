import 'dotenv/config';
import type { Hex } from 'viem';

export const env = {
  port: Number(process.env.PORT) || 8787,
  cosignerPk: (process.env.COSIGNER_PK || undefined) as Hex | undefined,
  relayerPk: (process.env.RELAYER_PK || undefined) as Hex | undefined,
  circleClientKey: process.env.CIRCLE_CLIENT_KEY || undefined,
  circleClientUrl: process.env.CIRCLE_CLIENT_URL || undefined,
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
