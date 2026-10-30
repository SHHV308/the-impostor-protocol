import { defineConfig } from '@playwright/test';

const PORT = 3200;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 150_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    // run `npm run build` first; the server serves dist/client and uses shortened meeting timers
    command: 'node dist/server/index.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), FAST_TIMERS: '1', NODE_ENV: 'development' },
    timeout: 30_000,
  },
});
