import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // The port files contain types only, there is no runtime code to cover.
      exclude: ['src/**/*.d.ts', 'src/domain/ports/**'],
      // A floor, not a wall: it catches a regression, it does not push.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 85,
        lines: 80,
      },
    },
  },
});

export default config;
