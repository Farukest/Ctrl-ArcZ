import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

// Integration tests read SENDER_/RECEIVER_PRIVATE_KEY from the repo-root .env.
loadEnv({ path: path.resolve(__dirname, '../../.env') });

const integrationGlob = ['test/integration/**'];

// `vitest` (default `test` script) runs unit tests only — no funds, no network.
// Integration tests run via `test:integration` (INTEGRATION=1), which needs a
// deployed contract and funded wallets. Excluding here (config, not a CLI flag)
// is reliable cross-platform; the shell-quoted `--exclude` did not strip quotes
// on Windows, so integration tests leaked into the unit run once a deploy address
// was set.
const runIntegration = process.env.INTEGRATION === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: runIntegration ? [] : integrationGlob,
  },
});
