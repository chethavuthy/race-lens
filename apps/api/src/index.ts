import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { HttpError } from './lib';
import { publicRoutes } from './routes/public';
import { adminRoutes } from './routes/admin';
import { internalRoutes } from './routes/internal';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', (c, next) =>
  cors({
    origin: (origin) => {
      // WEB_ORIGIN is a comma-separated allowlist: the site runs on a custom
      // domain and on *.pages.dev during rollout, and both must pass CORS.
      const allowed = [
        ...c.env.WEB_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
        'http://localhost:5173',
      ];
      return allowed.includes(origin) ? origin : allowed[0];
    },
    allowHeaders: ['Content-Type', 'X-Ingest-Secret'],
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    maxAge: 86400,
  })(c, next),
);

app.route('/api', publicRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/internal', internalRoutes);

/**
 * Fallback asset serving for thumbnails and banners. Only used when
 * R2_PUBLIC_BASE is unset — with a custom domain on the bucket, R2 serves these
 * directly and this route never gets hit.
 */
/**
 * Bump when the RESPONSE HEADERS below change.
 *
 * These responses are stored in the colo cache under `Cache-Control: immutable,
 * max-age=1 year`, so a header added today would not reach a client that
 * already has the old copy cached until 2027. The site now sends
 * `Cross-Origin-Embedder-Policy: require-corp`, which BLOCKS any cross-origin
 * subresource lacking `Cross-Origin-Resource-Policy` — so a stale cached
 * response is not a cosmetic problem, it is a missing photo.
 *
 * The version rides in the cache key only. It never appears in the URL the
 * browser requested, so thumbnail URLs stored in the database stay valid.
 */
const ASSET_HEADER_VERSION = '2';

app.get('/r2/*', async (c) => {
  const key = c.req.path.replace(/^\/r2\//, '');
  if (!/^(thumbs|banners)\//.test(key)) return c.notFound();

  const cache = caches.default;
  const cacheUrl = new URL(c.req.url);
  cacheUrl.searchParams.set('hv', ASSET_HEADER_VERSION);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.notFound();

  const res = new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: obj.httpEtag,
      // The site is cross-origin-isolated so onnxruntime can use threads, which
      // means every cross-origin subresource must opt in explicitly. Without
      // this header the browser drops every thumbnail on the floor.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

app.get('/health', (c) => c.json({ ok: true }));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, code: err.code ?? 'error' }, err.status as any);
  }
  console.error('unhandled', err);
  return c.json({ error: 'Internal error', code: 'internal' }, 500);
});

export default app;
