import { Hono } from 'hono';
import type { Env } from '../types';
import { HttpError, chunk, newId, nowIso, timingSafeEqual } from '../lib';
import { D1_MAX_PARAMS, invalidateIndex } from '../search';

export const internalRoutes = new Hono<{ Bindings: Env }>();

internalRoutes.use('*', async (c, next) => {
  const secret = c.req.header('X-Ingest-Secret') ?? '';
  if (!c.env.INGEST_SECRET || !timingSafeEqual(secret, c.env.INGEST_SECRET)) {
    throw new HttpError(401, 'Bad ingest secret', 'unauthorized');
  }
  await next();
});

internalRoutes.post('/jobs/:id/progress', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json<{ done?: number; total?: number; status?: string; error?: string }>();
  await c.env.DB.prepare(
    `UPDATE jobs SET done = COALESCE(?, done),
                     total = COALESCE(?, total),
                     status = COALESCE(?, status),
                     error = COALESCE(?, error),
                     updated_at = ?
      WHERE id = ?`,
  ).bind(b.done ?? null, b.total ?? null, b.status ?? null, b.error ?? null, nowIso(), id).run();
  return c.json({ ok: true });
});

interface PhotoIn {
  drive_file_id: string;
  thumb_key: string;
  width?: number | null;
  height?: number | null;
  taken_at?: string | null;
}

/**
 * Batch upsert. Returns drive_file_id -> photo_id so the runner can attach
 * faces and bibs to rows it did not itself name.
 */
internalRoutes.post('/events/:id/photos', async (c) => {
  const eventId = c.req.param('id');
  const { source_id, photos } = await c.req.json<{ source_id: string; photos: PhotoIn[] }>();
  if (!source_id || !Array.isArray(photos)) throw new HttpError(400, 'source_id and photos are required', 'bad_request');

  // Without this the insert trips the photos->sources foreign key and surfaces
  // as an opaque 500 in the runner log. Fail with something diagnosable.
  const source = await c.env.DB.prepare(
    'SELECT id FROM sources WHERE id = ? AND event_id = ?',
  ).bind(source_id, eventId).first();
  if (!source) throw new HttpError(400, `No source ${source_id} on event ${eventId}`, 'no_source');

  // 7 bound params per row; stay well under SQLite's 999-variable ceiling.
  for (const part of chunk(photos, 100)) {
    await c.env.DB.batch(
      part.map((p) =>
        c.env.DB.prepare(
          `INSERT INTO photos (id, event_id, source_id, drive_file_id, thumb_key, width, height, taken_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id, drive_file_id) DO UPDATE SET
             thumb_key = excluded.thumb_key,
             width     = excluded.width,
             height    = excluded.height,
             taken_at  = excluded.taken_at`,
        ).bind(newId(), eventId, source_id, p.drive_file_id, p.thumb_key,
               p.width ?? null, p.height ?? null, p.taken_at ?? null),
      ),
    );
  }

  const ids: Record<string, string> = {};
  // Same D1 100-parameter ceiling as the search join.
  for (const part of chunk(photos.map((p) => p.drive_file_id), D1_MAX_PARAMS - 1)) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, drive_file_id FROM photos
        WHERE event_id = ? AND drive_file_id IN (${part.map(() => '?').join(',')})`,
    ).bind(eventId, ...part).all<{ id: string; drive_file_id: string }>();
    for (const r of results) ids[r.drive_file_id] = r.id;
  }

  return c.json({ ok: true, photo_ids: ids });
});

/**
 * drive_file_ids already indexed for this event.
 *
 * Lets a re-run skip what it already has. Without this, a run that dies partway
 * re-downloads the same prefix every time and can never get past whatever wall
 * stopped it — the Angkor album stalled at the same 50 photos on repeat runs
 * because Drive rate-limits sustained bulk downloads.
 */
internalRoutes.get('/events/:id/indexed', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT drive_file_id FROM photos WHERE event_id = ?',
  ).bind(c.req.param('id')).all<{ drive_file_id: string }>();
  return c.json({ drive_file_ids: results.map((r) => r.drive_file_id) });
});

internalRoutes.post('/events/:id/bibs', async (c) => {
  const eventId = c.req.param('id');
  const { bibs } = await c.req.json<{ bibs: { photo_id: string; bib: string; conf?: number }[] }>();
  if (!Array.isArray(bibs)) throw new HttpError(400, 'bibs is required', 'bad_request');

  for (const part of chunk(bibs, 150)) {
    await c.env.DB.batch(
      part.map((b) =>
        c.env.DB.prepare(
          `INSERT INTO bibs (event_id, bib, photo_id, conf) VALUES (?, ?, ?, ?)
           ON CONFLICT (event_id, bib, photo_id) DO UPDATE SET conf = MAX(conf, excluded.conf)`,
        ).bind(eventId, b.bib, b.photo_id, b.conf ?? null),
      ),
    );
  }
  return c.json({ ok: true, inserted: bibs.length });
});

/**
 * Allocate the global row range for a shard.
 *
 * The runner cannot pick row_base itself: two sources indexed concurrently
 * would both start at the same offset and silently overwrite each other's rows.
 * Re-running an existing source reuses its range when it still fits, which is
 * what keeps a re-run idempotent rather than additive.
 */
internalRoutes.post('/events/:id/reserve-rows', async (c) => {
  const eventId = c.req.param('id');
  const { shard_key, count } = await c.req.json<{ shard_key: string; count: number }>();
  if (!shard_key || !Number.isInteger(count) || count < 0) {
    throw new HttpError(400, 'shard_key and a non-negative integer count are required', 'bad_request');
  }

  const existing = await c.env.DB.prepare(
    'SELECT row_base, row_count FROM face_shards WHERE event_id = ? AND shard_key = ?',
  ).bind(eventId, shard_key).first<{ row_base: number; row_count: number }>();
  if (existing && count <= existing.row_count) {
    return c.json({ row_base: existing.row_base, reused: true });
  }

  const max = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(row_base + row_count), 0) AS next FROM face_shards
      WHERE event_id = ? AND shard_key != ?`,
  ).bind(eventId, shard_key).first<{ next: number }>();

  const rowBase = max?.next ?? 0;
  await c.env.DB.prepare(
    `INSERT INTO face_shards (event_id, shard_key, row_base, row_count) VALUES (?, ?, ?, ?)
     ON CONFLICT (event_id, shard_key) DO UPDATE SET row_base = excluded.row_base, row_count = excluded.row_count`,
  ).bind(eventId, shard_key, rowBase, count).run();

  return c.json({ row_base: rowBase, reused: false });
});

internalRoutes.post('/events/:id/faces', async (c) => {
  const eventId = c.req.param('id');
  const { shard_key, row_base, row_count, rows, replace } = await c.req.json<{
    shard_key: string;
    row_base: number;
    row_count: number;
    replace?: boolean;
    rows: { photo_id: string; row_idx: number; bbox: number[]; bib?: string | null }[];
  }>();
  if (!shard_key || !Array.isArray(rows)) throw new HttpError(400, 'shard_key and rows are required', 'bad_request');

  await c.env.DB.prepare(
    `INSERT INTO face_shards (event_id, shard_key, row_base, row_count) VALUES (?, ?, ?, ?)
     ON CONFLICT (event_id, shard_key) DO UPDATE SET row_base = excluded.row_base, row_count = excluded.row_count`,
  ).bind(eventId, shard_key, row_base, row_count ?? rows.length).run();

  // Re-running a source rewrites the same row range; clear it first so the
  // unique index on (event_id, row_idx) does not reject the new rows. Only the
  // runner's FIRST chunk sets `replace` — later chunks must not wipe the rows
  // their predecessors just wrote.
  if (replace !== false) {
    await c.env.DB.prepare(
      'DELETE FROM faces WHERE event_id = ? AND row_idx >= ? AND row_idx < ?',
    ).bind(eventId, row_base, row_base + (row_count ?? rows.length)).run();
  }

  for (const part of chunk(rows, 120)) {
    await c.env.DB.batch(
      part.map((f) =>
        c.env.DB.prepare(
          'INSERT INTO faces (id, event_id, photo_id, row_idx, bbox, bib) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(newId(), eventId, f.photo_id, f.row_idx, JSON.stringify(f.bbox), f.bib ?? null),
      ),
    );
  }

  invalidateIndex(eventId);
  return c.json({ ok: true, inserted: rows.length });
});

internalRoutes.post('/events/:id/finalize', async (c) => {
  const eventId = c.req.param('id');
  const { status } = await c.req.json<{ status?: 'ready' | 'partial' }>().catch(() => ({ status: undefined }));

  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM photos WHERE event_id = ?1) AS photos,
            (SELECT COUNT(*) FROM faces  WHERE event_id = ?1) AS faces`,
  ).bind(eventId).first<{ photos: number; faces: number }>();

  await c.env.DB.prepare(
    'UPDATE events SET photo_count = ?, face_count = ?, status = ? WHERE id = ?',
  ).bind(counts?.photos ?? 0, counts?.faces ?? 0, status ?? 'ready', eventId).run();

  invalidateIndex(eventId);
  return c.json({ ok: true, photo_count: counts?.photos ?? 0, face_count: counts?.faces ?? 0 });
});
