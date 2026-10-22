import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  entry: ['src/cli/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: true,
  unbundle: false,
  banner: '#!/usr/bin/env node',
});

export default config;
