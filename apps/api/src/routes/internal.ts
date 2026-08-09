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
/**
 * Re-dispatch a job that stopped early on a Drive rate limit.
 *
 * Drive throttles sustained bulk downloading, so a large album of full-size
 * originals reliably stops around 1 GB. Resume means each run makes progress,
 * but without this the organizer has to notice and press the button again —
 * repeatedly, for one album. The runner asks for a continuation instead.
 *
 * Two independent guards, because a folder that can never finish must not loop:
 *
 *   1. A pass that indexed NOTHING ends the chain. This is the guard that
 *      actually matters — it is measured, not guessed. If Drive's quota has not
 *      recovered, the next run downloads nothing either, so continuing just
 *      burns CI minutes to no effect.
 *   2. A hard ceiling on attempts, as a backstop against a bug that reports
 *      progress it did not make.
 *
 * The ceiling used to be 8, which was sized for albums of a few hundred photos.
 * At ~25 photos per quota window on full originals that capped a chain at ~200
 * photos, so a 31k-photo folder needed ~150 manual presses. Since guard 1 stops
 * a chain the moment it stops progressing, the ceiling can be generous.
 */
internalRoutes.post('/jobs/:id/continue', async (c) => {
  const id = c.req.param('id');
  const MAX_ATTEMPTS = 60;

  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<any>();
  if (!job) throw new HttpError(404, 'Job not found', 'no_job');

  // Guard 1: no progress means the quota has not recovered. Stop.
  if ((job.done ?? 0) === 0) {
    await c.env.DB.prepare(
      `UPDATE jobs SET status = 'partial', error = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      'Drive served no photos this pass — its download quota has not reset yet. ' +
        'Press Re-index later to continue.',
      nowIso(), id,
    ).run();
    return c.json({ dispatched: false, reason: 'no_progress' });
  }

  if ((job.attempts ?? 0) >= MAX_ATTEMPTS) {
    await c.env.DB.prepare(
      "UPDATE jobs SET status = 'partial', error = ?, updated_at = ? WHERE id = ?",
    ).bind(
      `Stopped after ${MAX_ATTEMPTS} automatic continuations — Drive is still rate-limiting this folder. Everything indexed so far is live; press Start indexing again later to resume.`,
      nowIso(), id,
    ).run();
    return c.json({ dispatched: false, reason: 'max_attempts' });
  }

  // image_source has to come along: the workflow defaults to 'original' when the
  // key is absent, so omitting it silently downgraded every continuation of a
  // 'thumb' source back to full-size downloads — and straight back into the
  // quota that ended the previous pass.
  const source = await c.env.DB
    .prepare('SELECT drive_folder_id, image_source FROM sources WHERE id = ?')
    .bind(job.source_id).first<{ drive_folder_id: string; image_source: string | null }>();
  if (!source) throw new HttpError(400, 'Job has no source to continue', 'no_source');

  const res = await fetch(`https://api.github.com/repos/${c.env.GH_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'race-lens-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'index-event',
      client_payload: {
        event_id: job.event_id, source_id: job.source_id,
        folder_id: source.drive_folder_id, job_id: id,
        image_source: source.image_source ?? 'original',
      },
    }),
  });

  if (!res.ok) {
    return c.json({ dispatched: false, reason: `github_${res.status}` });
  }

  await c.env.DB.prepare(
    `UPDATE jobs SET attempts = attempts + 1, status = 'queued',
                     error = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    `Drive rate limit — continuing automatically (attempt ${(job.attempts ?? 0) + 2} of ${MAX_ATTEMPTS + 1}).`,
    nowIso(), id,
  ).run();

  return c.json({ dispatched: true, attempts: (job.attempts ?? 0) + 1 });
});

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
  // `?complete=1` means "photos that already have FACES", not merely "photos
  // that exist". That is the correct resume key for a rebuild: after wiping
  // faces, every photo still exists, so plain resume would skip everything and
  // do nothing — while --no-resume would re-process photos already rebuilt in
  // an earlier pass and duplicate their vectors.
  const complete = c.req.query('complete') === '1';
  const sql = complete
    ? `SELECT p.drive_file_id FROM photos p
        WHERE p.event_id = ? AND EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id)`
    : 'SELECT drive_file_id FROM photos WHERE event_id = ?';
  const { results } = await c.env.DB.prepare(sql)
    .bind(c.req.param('id')).all<{ drive_file_id: string }>();
  return c.json({ drive_file_ids: results.map((r) => r.drive_file_id) });
});

/**
 * Per-event indexing settings, fetched by the runner at startup.
 *
 * Deliberately NOT part of the dispatch payload. image_source is passed that
 * way and it cost us: two of the three dispatch sites forgot the field, the
 * workflow silently defaulted it, and a whole album re-downloaded at full size
 * for days before anyone could see why. One endpoint the runner always calls
 * cannot be forgotten by a caller that does not exist.
 */
internalRoutes.get('/events/:id/config', async (c) => {
  const row = await c.env.DB.prepare('SELECT bibs_enabled FROM events WHERE id = ?')
    .bind(c.req.param('id')).first<{ bibs_enabled: number }>();
  if (!row) throw new HttpError(404, 'Event not found', 'no_event');
  return c.json({ bibs_enabled: row.bibs_enabled !== 0 });
});

internalRoutes.post('/events/:id/bibs', async (c) => {
  const eventId = c.req.param('id');
  const { bibs, replace_photos } = await c.req.json<{
    bibs: { photo_id: string; bib: string; bib_raw?: string; conf?: number }[];
    replace_photos?: string[];
  }>();
  if (!Array.isArray(bibs)) throw new HttpError(400, 'bibs is required', 'bad_request');

  // Clear each photo's existing bibs first, so a re-read is AUTHORITATIVE.
  //
  // This endpoint only ever inserted/updated, so a number the old code misread
  // survived every subsequent re-read. Tightening the rules could add correct
  // bibs but never retract wrong ones — 250 stale rows, 57 of them fragments
  // the current rules reject outright.
  if (Array.isArray(replace_photos) && replace_photos.length) {
    for (const part of chunk(replace_photos, D1_MAX_PARAMS - 1)) {
      // source = 'ocr' only. A human correction outranks the model and must
      // survive every future re-index — otherwise the organizer would fix a
      // number and silently lose it on the next pass.
      await c.env.DB.prepare(
        `DELETE FROM bibs WHERE event_id = ? AND source = 'ocr'
           AND photo_id IN (${part.map(() => '?').join(',')})`,
      ).bind(eventId, ...part).run();
    }
  }

  // Drop anything the organizer explicitly rejected. Without this a wrong OCR
  // read returns on the very next re-index and the correction looks undone.
  let accepted = bibs;
  if (bibs.length) {
    const { results: rejects } = await c.env.DB.prepare(
      'SELECT photo_id, bib FROM bib_rejects WHERE event_id = ?',
    ).bind(eventId).all<{ photo_id: string; bib: string }>();
    if (rejects.length) {
      const blocked = new Set(rejects.map((r) => `${r.photo_id}|${r.bib}`));
      accepted = bibs.filter((b) => !blocked.has(`${b.photo_id}|${b.bib}`));
    }
  }

  for (const part of chunk(accepted, 150)) {
    await c.env.DB.batch(
      part.map((b) =>
        c.env.DB.prepare(
          `INSERT INTO bibs (event_id, bib, photo_id, conf, bib_raw, source)
           VALUES (?, ?, ?, ?, ?, 'ocr')
           ON CONFLICT (event_id, bib, photo_id) DO UPDATE SET
             conf = MAX(conf, excluded.conf),
             bib_raw = excluded.bib_raw
           WHERE bibs.source = 'ocr'`,
        ).bind(eventId, b.bib, b.photo_id, b.conf ?? null, b.bib_raw ?? null),
      ),
    );
  }
  return c.json({ ok: true, inserted: accepted.length, rejected: bibs.length - accepted.length });
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

/** Append ingest journal entries. Batched by the runner. */
internalRoutes.post('/events/:id/log', async (c) => {
  const eventId = c.req.param('id');
  const { entries } = await c.req.json<{
    entries: { job_id?: string; source_id?: string; level?: string;
               code?: string; message: string; drive_file_id?: string }[];
  }>();
  if (!Array.isArray(entries) || !entries.length) return c.json({ ok: true, inserted: 0 });

  const ts = nowIso();
  for (const part of chunk(entries, 100)) {
    await c.env.DB.batch(
      part.map((e) =>
        c.env.DB.prepare(
          `INSERT INTO ingest_log (event_id, job_id, source_id, level, code, message, drive_file_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(eventId, e.job_id ?? null, e.source_id ?? null, e.level ?? 'info',
               e.code ?? null, String(e.message).slice(0, 500), e.drive_file_id ?? null, ts),
      ),
    );
  }
  return c.json({ ok: true, inserted: entries.length });
});

/** Record how many images the walk found, so "found vs indexed" is comparable. */
internalRoutes.post('/sources/:id/discovered', async (c) => {
  const { count } = await c.req.json<{ count: number }>();
  await c.env.DB.prepare('UPDATE sources SET discovered = ? WHERE id = ?')
    .bind(Number(count) || 0, c.req.param('id')).run();
  return c.json({ ok: true });
});

internalRoutes.post('/benchmarks/:id', async (c) => {
  const b = await c.req.json<{ status?: string; result?: string; error?: string }>();
  await c.env.DB.prepare(
    `UPDATE benchmarks SET status = COALESCE(?, status),
                           result = COALESCE(?, result),
                           error  = COALESCE(?, error),
                           updated_at = ? WHERE id = ?`,
  ).bind(b.status ?? null, b.result ?? null, b.error ?? null, nowIso(), c.req.param('id')).run();
  return c.json({ ok: true });
});

internalRoutes.post('/events/:id/finalize', async (c) => {
  const eventId = c.req.param('id');
  const { status } = await c.req.json<{ status?: 'ready' | 'partial' }>().catch(() => ({ status: undefined }));

  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM photos WHERE event_id = ?1) AS photos,
            (SELECT COUNT(*) FROM faces  WHERE event_id = ?1) AS faces`,
  ).bind(eventId).first<{ photos: number; faces: number }>();

  // 'ready' is a claim about the whole event, but the runner making it only ever
  // saw one source. On a two-link event, the pass that finished link A marked
  // the event ready while link B was still 260 photos short — and the "nothing
  // left to index" early return fires exactly when someone re-indexes an
  // already-complete link, so it took one button press to mislabel the event.
  // Verify the claim against every source instead of taking the runner's word.
  const short = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sources s
      WHERE s.event_id = ?
        AND COALESCE(s.discovered, 0) >
            (SELECT COUNT(*) FROM photos p WHERE p.source_id = s.id)`,
  ).bind(eventId).first<{ n: number }>();

  const resolved = status === 'partial' || (short?.n ?? 0) > 0 ? 'partial' : 'ready';

  await c.env.DB.prepare(
    'UPDATE events SET photo_count = ?, face_count = ?, status = ? WHERE id = ?',
  ).bind(counts?.photos ?? 0, counts?.faces ?? 0, resolved, eventId).run();

  invalidateIndex(eventId);
  return c.json({ ok: true, photo_count: counts?.photos ?? 0, face_count: counts?.faces ?? 0 });
});
