import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'conformance/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
