import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
    {
      /*
       * Refuse to build a bundle with VITE_API_BASE baked in.
       *
       * resolveApiBase() in lib/api.ts picks the API origin at RUNTIME, because
       * one build serves several hostnames and the custom domain must stay
       * same-origin — Cloudflare Access issues a host-scoped cookie, and a
       * cross-origin admin fetch silently drops it, permanently breaking /admin.
       *
       * `import.meta.env.VITE_API_BASE` is substituted at build time, so setting
       * it collapses that whole function to a constant and the hostname check
       * disappears from the output. This shipped once, from a `.env.local` that
       * was only ever meant for the dev server — Vite loads `.env.local` in
       * every mode, `vite build` included. Nothing failed loudly: public pages
       * kept working because CORS allows them, and only /admin broke.
       *
       * Use `.env.development.local` for dev overrides. If a build genuinely
       * needs a different API origin, change resolveApiBase() rather than
       * reaching for an env var it cannot validate.
       */
      name: 'race-lens:forbid-baked-api-base',
      apply: 'build',
      config(_config, { mode }) {
        const baked = process.env.VITE_API_BASE;
        if (!baked) return;
        throw new Error(
          `VITE_API_BASE is set ("${baked}") for a ${mode} build.\n` +
            'That hardcodes the API origin into the bundle and breaks /admin on the\n' +
            'custom domain, because the Cloudflare Access cookie is host-scoped and\n' +
            'cannot travel cross-origin.\n' +
            'Unset it, or move the override into apps/web/.env.development.local.',
        );
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
  // shadcn generates components that import from '@/components/ui/*' and
  // '@/lib/utils', so the alias is part of the contract with the registry rather
  // than a convenience. Mirrored in tsconfig paths.
  resolve: { alias: { '@': here('./src') } },
  build: { target: 'es2022' },
  // onnxruntime-web ships prebuilt wasm; excluding it from optimizeDeps keeps
  // Vite from trying to rewrite the worker/wasm loader paths.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
