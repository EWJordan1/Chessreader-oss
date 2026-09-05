import { defineConfig } from 'vite';

export default defineConfig({
  // The app is served from wherever it is unpacked, so every URL in it is relative.
  base: './',
  server: { port: 5173, strictPort: false, open: false },
  build: {
    target: 'es2022',
    // The engine is 7 MB of wasm that is fetched lazily by URL; Vite must copy it
    // through untouched rather than try to inline or hash-rename it (the loader
    // derives the .wasm path from its own filename — see engine/README.md).
    assetsInlineLimit: 0,
  },
});
