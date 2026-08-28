import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the app's own logic, which until now had none.
 *
 * Nothing here touches the network or a wallet. The store under test is pure
 * bookkeeping over a read function it is handed, so a fake read is the whole
 * fixture.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A `localStorage` before any module is imported. See test/setup.ts.
    setupFiles: ['./test/setup.ts'],
  },
});
