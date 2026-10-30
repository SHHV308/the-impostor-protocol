import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: { '@impostor/shared': new URL('./shared/src/index.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') },
  },
});
