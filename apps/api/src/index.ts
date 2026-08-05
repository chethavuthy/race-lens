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
      const allowed = [c.env.WEB_ORIGIN, 'http://localhost:5173'];
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
app.get('/r2/*', async (c) => {
  const key = c.req.path.replace(/^\/r2\//, '');
  if (!/^(thumbs|banners)\//.test(key)) return c.notFound();

  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) return cached;

  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.notFound();

  const res = new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: obj.httpEtag,
    },
  });
  c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()));
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
