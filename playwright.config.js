import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test',
  testMatch: /walk\.spec\.js/,
  timeout: 60_000,
  use: {
    // Desktop only (§2.1): the walk runs at a desk width and nothing smaller.
    viewport: { width: 1440, height: 900 },
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'npm run dev -- --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  snapshotPathTemplate: '{testDir}/walk/__screenshots__/{arg}{ext}',
});
