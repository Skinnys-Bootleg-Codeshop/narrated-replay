import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['e2e/**', 'examples/**', 'node_modules/**'] },
});
