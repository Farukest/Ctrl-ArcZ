import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

// Integration tests read the relayer and co-signer keys from the repo-root .env,
// the same place the SDK's do.
loadEnv({ path: path.resolve(__dirname, '../../.env') });
loadEnv({ path: path.resolve(__dirname, '../../apps/api/.env') });

const integrationGlob = ['test/integration/**'];

/**
 * `pnpm test` runs unit tests only: no keys, no network, no spend. The integration
 * tests deploy real boxes on four testnets, so they are opt-in through INTEGRATION=1
 * exactly as the SDK's are. Excluded here in config rather than by a CLI flag,
 * because a shell-quoted `--exclude` does not strip quotes on Windows.
 */
const runIntegration = process.env.INTEGRATION === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: runIntegration ? [] : integrationGlob,
  },
});
