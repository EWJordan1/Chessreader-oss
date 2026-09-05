/* The live-engine spec runs on purpose, not on every commit: see engine-live.spec.js. */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /engine-live\.spec\.js/,
  timeout: 180_000,
  use: { viewport: { width: 1440, height: 900 }, baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'npx vite --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
    cwd: '..',
  },
});
