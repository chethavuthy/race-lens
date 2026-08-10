import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    vue(),
    {
      // public/golden holds the Phase 5 fixtures (a test face photo and its
      // reference embedding). Vite copies all of public/ into dist, and those
      // have no business on a production origin — the /golden route is dev-only.
      name: 'race-lens:strip-golden-fixtures',
      apply: 'build',
      closeBundle() {
        rmSync(here('dist/golden'), { recursive: true, force: true });
      },
    },
  ],
  server: {
    // NOTE: production deliberately does not send COOP/COEP — see the long
    // note in public/_headers. If you re-enable them there, mirror them here
    // too, or COEP failures (silently blocked images) will only ever show up
    // after a deploy.
    proxy: {
      // Local wrangler dev on 8787; keeps the frontend same-origin in dev.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/r2': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: { target: 'es2022' },
  // onnxruntime-web ships prebuilt wasm; excluding it from optimizeDeps keeps
  // Vite from trying to rewrite the worker/wasm loader paths.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
