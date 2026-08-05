import { Hono } from 'hono';
import type { Env, EventRow } from '../types';
import { HttpError, publicEvent, publicPhoto } from '../lib';
import { searchFaces } from '../search';

export const publicRoutes = new Hono<{ Bindings: Env }>();

async function getEventBySlug(env: Env, slug: string, includeDrafts = false): Promise<EventRow> {
  const sql = includeDrafts
    ? 'SELECT * FROM events WHERE slug = ?'
    : "SELECT * FROM events WHERE slug = ? AND status IN ('ready','partial')";
  const row = await env.DB.prepare(sql).bind(slug).first<EventRow>();
  if (!row) throw new HttpError(404, 'Event not found', 'no_event');
  return row;
}

publicRoutes.get('/events', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM events
      WHERE status IN ('ready','partial')
      ORDER BY COALESCE(event_date, created_at) DESC`,
  ).all<EventRow>();
  return c.json({ events: results.map((e) => publicEvent(c.env, e)) });
});

publicRoutes.get('/events/:slug', async (c) => {
  const event = await getEventBySlug(c.env, c.req.param('slug'));
  const { results } = await c.env.DB.prepare(
    `SELECT id, drive_file_id, thumb_key, width, height, taken_at
       FROM photos WHERE event_id = ? ORDER BY id LIMIT 60`,
  ).bind(event.id).all<any>();
  return c.json({
    event: publicEvent(c.env, event),
    photos: results.map((p) => publicPhoto(c.env, p)),
    cursor: results.length === 60 ? results[results.length - 1].id : null,
  });
});

publicRoutes.get('/events/:slug/photos', async (c) => {
  const event = await getEventBySlug(c.env, c.req.param('slug'));
  const limit = Math.min(Number(c.req.query('limit') ?? 60) || 60, 200);
  const cursor = c.req.query('cursor') ?? '';
  // Keyset pagination on the primary key — stable and index-only.
  const { results } = await c.env.DB.prepare(
    `SELECT id, drive_file_id, thumb_key, width, height, taken_at
       FROM photos WHERE event_id = ? AND id > ? ORDER BY id LIMIT ?`,
  ).bind(event.id, cursor, limit).all<any>();
  return c.json({
    photos: results.map((p) => publicPhoto(c.env, p)),
    cursor: results.length === limit ? results[results.length - 1].id : null,
  });
});

publicRoutes.get('/events/:slug/bib/:bib', async (c) => {
  const event = await getEventBySlug(c.env, c.req.param('slug'));
  // Strip non-digits, then leading zeros — the indexer stores bibs normalized
  // the same way, so "0123" and "123" resolve to the same row.
  const digits = c.req.param('bib').replace(/\D/g, '');
  const bib = digits.replace(/^0+(?=\d)/, '');
  if (!bib) return c.json({ photos: [], matched: null });

  const select = `SELECT p.id, p.drive_file_id, p.thumb_key, p.width, p.height, p.taken_at, b.conf
                    FROM bibs b JOIN photos p ON p.id = b.photo_id
                   WHERE b.event_id = ?`;

  let matched: 'exact' | 'suffix' = 'exact';
  let { results } = await c.env.DB.prepare(`${select} AND b.bib = ? ORDER BY b.conf DESC LIMIT 200`)
    .bind(event.id, bib).all<any>();

  // OCR drops leading digits often enough that a suffix fallback meaningfully
  // improves recall — e.g. "1234" read as "234".
  if (results.length === 0) {
    matched = 'suffix';
    const r = await c.env.DB.prepare(`${select} AND b.bib LIKE ? ORDER BY b.conf DESC LIMIT 200`)
      .bind(event.id, `%${bib}`).all<any>();
    results = r.results;
  }

  return c.json({
    matched: results.length ? matched : null,
    photos: results.map((p) => publicPhoto(c.env, p)),
  });
});

publicRoutes.post('/events/:slug/search/face', async (c) => {
  const event = await getEventBySlug(c.env, c.req.param('slug'));
  const body = await c.req.json<{ vec?: unknown }>().catch(() => ({} as any));
  const vec = body.vec;
  if (!Array.isArray(vec) || vec.length !== 512 || !vec.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new HttpError(400, 'Body must be { vec: number[512] } of finite numbers', 'bad_vec');
  }
  const threshold = Number(c.req.query('t') ?? 0.38);
  const { matches, timing } = await searchFaces(c.env, event.id, vec as number[], {
    threshold: Number.isFinite(threshold) ? threshold : 0.38,
    ctx: c.executionCtx,
  });
  // Server-side timing, so latency work is driven by the Worker's own numbers
  // rather than by round-trip wall clock from wherever the client happens to be.
  c.header(
    'Server-Timing',
    `load;dur=${timing.loadMs},scan;dur=${timing.scanMs},join;dur=${timing.joinMs},total;dur=${timing.totalMs}`,
  );
  return c.json({
    event: publicEvent(c.env, event),
    matches,
    ...(c.req.query('debug') ? { timing } : {}),
  });
});
