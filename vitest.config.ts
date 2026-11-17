import { defineConfig } from 'vitest/config';

// Integration files start browsers, pseudo-terminals, MCP servers and containers. Run all at once on a
// loaded machine they starve each other and time-based assertions fail, so only a few run together.
// Unit and property tests are fast and keep the default parallelism.
export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'fast',
          setupFiles: ['./tests/setup/clean-env.ts'],
          include: ['tests/unit/**/*.test.ts', 'tests/property/**/*.test.ts'],
          // Some unit files start a real browser (capture-script): closing it can be slow under load
          testTimeout: 30000,
          hookTimeout: 60000,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          setupFiles: ['./tests/setup/clean-env.ts'],
          include: ['tests/integration/**/*.test.ts'],
          maxWorkers: 2,
          // After the fast group: the heavy files do not compete with it
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
