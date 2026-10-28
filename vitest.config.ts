import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Tests always run against the isolated test database/Redis DB from .env.test — never the dev/prod ones.
const testEnv = parse(readFileSync(new URL('./.env.test', import.meta.url)));

export default defineConfig({
  test: {
    env: testEnv,
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/cli/**', 'src/server.ts', 'src/worker.ts'] },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/helpers/global-setup.ts'],
          // Integration files share one database; a single fork runs them sequentially in one process.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
