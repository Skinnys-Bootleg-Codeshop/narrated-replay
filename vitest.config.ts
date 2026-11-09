import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.{ts,tsx}'], exclude: ['e2e/**', 'examples/**', 'node_modules/**'] },
});
