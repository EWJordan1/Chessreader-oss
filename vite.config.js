import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/*
 * Served as plain directories under the site root, never bundled: the engine loader
 * derives its .wasm path from its own filename (see src/engine/local.js), and the
 * lessons and opening tables are fetched by URL. Vite serves them from the project root
 * in dev; the build has to copy them across by hand or the built site 404s.
 */
const STATIC_DIRS = ['engine', 'openings', 'lessons'];
function copyStaticDirs() {
  let outDir;
  return {
    name: 'copy-static-dirs',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() {
      for (const dir of STATIC_DIRS) cpSync(resolve(dir), resolve(outDir, dir), { recursive: true });
    },
  };
}

export default defineConfig({
  // The app is served from wherever it is unpacked, so every URL in it is relative.
  base: './',
  plugins: [copyStaticDirs()],
  server: { port: 5173, strictPort: false, open: false },
  build: {
    target: 'es2022',
    // The engine is 7 MB of wasm that is fetched lazily by URL; Vite must copy it
    // through untouched rather than try to inline or hash-rename it (the loader
    // derives the .wasm path from its own filename — see docs/engine.md).
    assetsInlineLimit: 0,
    // Two pages: the landing at /, the app at /app.html (/app on hosts with clean URLs).
    rollupOptions: { input: { index: 'index.html', app: 'app.html' } },
  },
});
