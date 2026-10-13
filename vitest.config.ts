import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // vitest 5 defaults clearMocks to true, wiping the addListener calls recorded at import time.
    clearMocks: false,
    testTimeout: 15000,
    // ponytail: integration files all bind the fixture server to the same
    // fixed port and launch a real browser in beforeAll — run them one at a
    // time with generous hook headroom instead of giving each its own port.
    fileParallelism: false,
    hookTimeout: 60000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'happy-dom' } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
