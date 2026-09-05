import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // fake-indexeddb is wired per-suite (memory.test.js) rather than globally, so a
    // suite that never touches storage cannot accidentally depend on it.
  },
});
