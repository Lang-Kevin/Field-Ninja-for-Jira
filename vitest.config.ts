import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    environmentMatchGlobs: [['tests/integration/**', 'node']],
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 15000,
    // ponytail: integration files all bind the fixture server to the same
    // fixed port and launch a real browser in beforeAll — run them one at a
    // time with generous hook headroom instead of giving each its own port.
    fileParallelism: false,
    hookTimeout: 60000,
  },
});
