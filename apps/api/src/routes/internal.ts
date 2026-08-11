import { Hono } from 'hono';
import type { Env } from '../types';
import { HttpError, chunk, newId, nowIso, timingSafeEqual } from '../lib';
import { D1_MAX_PARAMS, DIM, invalidateIndex } from '../search';

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
  const b = await c.req.json<{
    done?: number; total?: number; status?: string; error?: string | null;
  }>();

  // `error` is the one field a caller needs to be able to CLEAR, and COALESCE
  // cannot express that — it reads a null as "leave it alone".
  //
  // /jobs/:id/continue writes "Drive rate limit — continuing automatically
  // (attempt N of 61)". Every later ping from the runner passes error=None, so that
  // message survived to the end of the chain and sat next to status='done' in the
  // admin UI. The organizer then cannot tell a chain that recovered from one that
  // is stuck, which is the whole question the report page exists to answer.
  //
  // Presence of the key, not its value, is the signal: omitting `error` preserves
  // whatever is there, sending null clears it.
  const clearError = 'error' in b;
  await c.env.DB.prepare(
    `UPDATE jobs SET done = COALESCE(?1, done),
                     total = COALESCE(?2, total),
                     status = COALESCE(?3, status),
                     error = CASE WHEN ?4 = 1 THEN ?5 ELSE error END,
                     updated_at = ?6
      WHERE id = ?7`,
  ).bind(
    b.done ?? null, b.total ?? null, b.status ?? null,
    clearError ? 1 : 0, b.error ?? null, nowIso(), id,
  ).run();
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
 * Re-dispatch a job that stopped early.
 *
 * Two walls stop a pass short, and the organizer should not have to know the
 * difference between them:
 *
 *   quota — Drive throttles sustained bulk downloading, so a large album of
 *           full-size originals reliably stops around 1 GB.
 *   time  — a runner is killed at 330 minutes. The pass now stops itself at 300
 *           and asks to continue, because the kill leaves no code running to
 *           ask: six consecutive passes over a 31k-photo folder died that way,
 *           each ~3,000 photos in, each needing a manual press to resume.
 *
 * Resume means each run makes progress, but without this the organizer has to
 * notice and press the button again — repeatedly, for one album. The runner
 * asks for a continuation instead.
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

  // Wording only — every guard below applies to both. Defaulted rather than
  // required so a runner from before the field existed still continues.
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
  const timedOut = body.reason === 'time';

  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<any>();
  if (!job) throw new HttpError(404, 'Job not found', 'no_job');

  // Guard 1: a pass that indexed nothing would repeat itself for nothing.
  if ((job.done ?? 0) === 0) {
    await c.env.DB.prepare(
      `UPDATE jobs SET status = 'partial', error = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      timedOut
        ? 'This pass ran out of time without indexing a photo. Press Re-index to try again.'
        : 'Drive served no photos this pass — its download quota has not reset yet. ' +
          'Press Re-index later to continue.',
      nowIso(), id,
    ).run();
    return c.json({ dispatched: false, reason: 'no_progress' });
  }

  if ((job.attempts ?? 0) >= MAX_ATTEMPTS) {
    await c.env.DB.prepare(
      "UPDATE jobs SET status = 'partial', error = ?, updated_at = ? WHERE id = ?",
    ).bind(
      `Stopped after ${MAX_ATTEMPTS} automatic continuations — ${
        timedOut ? 'this folder is taking more CI time than one chain allows'
                 : 'Drive is still rate-limiting this folder'
      }. Everything indexed so far is live; press Start indexing again later to resume.`,
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
    `${timedOut ? 'Reached this run’s time limit' : 'Drive rate limit'} — continuing ` +
      `automatically (attempt ${(job.attempts ?? 0) + 2} of ${MAX_ATTEMPTS + 1}).`,
    nowIso(), id,
  ).run();

  return c.json({ dispatched: true, attempts: (job.attempts ?? 0) + 1 });
});

internalRoutes.post('/events/:id/photos', async (c) => {
  const eventId = c.req.param('id');
  const { source_id, photos, faces_pending } = await c.req.json<{
    source_id: string; photos: PhotoIn[]; faces_pending?: boolean;
  }>();
  if (!source_id || !Array.isArray(photos)) throw new HttpError(400, 'source_id and photos are required', 'bad_request');

  // Does this pass intend to (re)write these photos' face vectors?
  //
  // True for an ordinary pass, false for --bibs-only, which re-reads numbers and
  // leaves faces and shards alone. Getting this wrong in the false direction would
  // mark every photo a bibs-only pass touched as unfinished, so the next resume
  // would re-download the entire album. Absent means true: a caller that has not
  // been taught about the flag is an ordinary pass.
  const facesPending = faces_pending !== false;

  // Without this the insert trips the photos->sources foreign key and surfaces
  // as an opaque 500 in the runner log. Fail with something diagnosable.
  const source = await c.env.DB.prepare(
    'SELECT id FROM sources WHERE id = ? AND event_id = ?',
  ).bind(source_id, eventId).first();
  if (!source) throw new HttpError(400, `No source ${source_id} on event ${eventId}`, 'no_source');

  // Validate drive_file_id, because this column later becomes a shell argument.
  //
  // POST /admin/photos/:id/reindex puts it in a repository_dispatch payload, and
  // the workflow passes it to `python -m indexer.main --only-file`. That step now
  // routes values through `env:` instead of interpolating them into the script, so
  // this is the second of two independent guards rather than the only one — but a
  // Drive file id has a known shape and nothing is gained by storing anything else.
  const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;
  for (const p of photos) {
    if (typeof p?.drive_file_id !== 'string' || !DRIVE_ID.test(p.drive_file_id)) {
      throw new HttpError(
        400,
        `Not a Drive file id: ${String(p?.drive_file_id).slice(0, 40)}`,
        'bad_file_id',
      );
    }
  }

  // 7 bound params per row; stay well under SQLite's 999-variable ceiling.
  for (const part of chunk(photos, 100)) {
    await c.env.DB.batch(
      part.map((p) =>
        c.env.DB.prepare(
          // COALESCE on the update, so an omitted field cannot erase a stored one.
          //
          // A --bibs-only pass sends drive_file_id and thumb_key alone: it does not
          // regenerate the thumbnail, so it has no dimensions to report and must not
          // claim any. With a bare `width = excluded.width` those arrive as NULL and
          // wipe the values every consumer of publicPhoto depends on — including the
          // denominator the grid divides faces.bbox by, which is the whole point of
          // storing them.
          // faces_done starts at 0 and only an ordinary pass resets it.
          //
          // A new row has no vectors yet by definition. On conflict it drops back to
          // 0 only when this pass is going to rewrite them, so a --bibs-only pass
          // cannot mark an already-indexed album unfinished — which would send the
          // next resume back to Drive for every photo in it.
          `INSERT INTO photos (id, event_id, source_id, drive_file_id, thumb_key, width, height, taken_at, faces_done)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
           ON CONFLICT (event_id, drive_file_id) DO UPDATE SET
             thumb_key  = excluded.thumb_key,
             width      = COALESCE(excluded.width, width),
             height     = COALESCE(excluded.height, height),
             taken_at   = COALESCE(excluded.taken_at, taken_at),
             faces_done = CASE WHEN ?9 = 1 THEN 0 ELSE faces_done END`,
        ).bind(newId(), eventId, source_id, p.drive_file_id, p.thumb_key,
               p.width ?? null, p.height ?? null, p.taken_at ?? null,
               facesPending ? 1 : 0),
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
 * Mark photos finished: their vectors are durable in a shard.
 *
 * Separate from POST /events/:id/faces on purpose, and this is the whole reason
 * the resume key works. /faces only knows the photos that PRODUCED a face row, but
 * a photo the detector found nobody in is just as finished — the pass downloaded
 * it, decoded it, ran detection and OCR, and there was nothing to store. Marking
 * only the photos with faces would leave that population at faces_done = 0 and
 * re-download it on every subsequent pass, forever, which is precisely the runaway
 * the `--rebuild` flag must never be put on the automatic continuation path to
 * avoid.
 *
 * So the runner calls this with every photo it actually processed, after the shard
 * flush. Anything that fails earlier simply never gets here, and the photo is
 * retried next pass.
 */
internalRoutes.post('/events/:id/photos/complete', async (c) => {
  const eventId = c.req.param('id');
  const { photo_ids } = await c.req.json<{ photo_ids: string[] }>();
  if (!Array.isArray(photo_ids)) {
    throw new HttpError(400, 'photo_ids is required', 'bad_request');
  }
  if (!photo_ids.length) return c.json({ ok: true, completed: 0 });

  let completed = 0;
  // event_id is in the WHERE as well as the id list: this is the only route that
  // can declare a photo finished, and it should not be able to do so for an event
  // other than the one in the path.
  for (const part of chunk(photo_ids, D1_MAX_PARAMS - 1)) {
    const r = await c.env.DB.prepare(
      `UPDATE photos SET faces_done = 1
        WHERE event_id = ? AND id IN (${part.map(() => '?').join(',')})`,
    ).bind(eventId, ...part).run();
    completed += r.meta.changes ?? 0;
  }
  return c.json({ ok: true, completed });
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
    // "vectors are durable", not "the row exists". The old key skipped photos
    // stranded by an interrupted batch forever; faces_done is only set once the
    // shard carrying that photo's vectors has actually landed.
    : 'SELECT drive_file_id FROM photos WHERE event_id = ? AND faces_done = 1';
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
          // Idempotent, because this POST gets retried.
          //
          // upload.py::_post retries on any requests.RequestException — including a
          // read timeout that arrived AFTER the Worker had already committed. The
          // retry then re-inserts the same rows, and only the runner's first chunk
          // sets `replace`, so a bare INSERT tripped the unique index on
          // (event_id, row_idx), returned 500, exhausted the five retries and failed
          // the whole run — with the shard bytes already durable in R2. One flaky
          // connection cost an entire pass.
          `INSERT INTO faces (id, event_id, photo_id, row_idx, bbox, bib)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id, row_idx) DO UPDATE SET
             photo_id = excluded.photo_id,
             bbox     = excluded.bbox,
             bib      = excluded.bib`,
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

  // Counts always; status only for an event that is already published or indexing.
  //
  // 'draft' means the organizer unpublished it, and PATCH /admin/events/:id offers
  // exactly that. This write was unconditional, so any later pass — including an
  // automatic continuation hours later — put the event back on the public site
  // behind their back. The route already refuses to take the runner's word about
  // readiness (see `short` above); it should be no more trusting about visibility.
  await c.env.DB.prepare(
    `UPDATE events SET photo_count = ?, face_count = ?,
                       status = CASE WHEN status = 'draft' THEN status ELSE ? END
      WHERE id = ?`,
  ).bind(counts?.photos ?? 0, counts?.faces ?? 0, resolved, eventId).run();

  invalidateIndex(eventId);
  return c.json({ ok: true, photo_count: counts?.photos ?? 0, face_count: counts?.faces ?? 0 });
});

/**
 * Upload a face-embedding shard into the private bucket.
 *
 * The indexer cannot write there directly: its R2 API token is scoped to the
 * public `race-lens` bucket, and that bucket now sits behind a custom domain
 * which publishes everything in it. Rather than rotate credentials, the shard
 * bytes come through here and are written with the INDEX_BUCKET binding, which
 * has no such scoping.
 *
 * Volume makes this cheap: shards average ~79 KB and three indexed events have
 * produced ~700 of them in total, against millions of thumbnail requests.
 */
internalRoutes.put('/shards/*', async (c) => {
  const key = c.req.path.replace(/^\/api\/internal\/shards\//, '');
  // Confine writes to the shard namespace: this endpoint holds the only
  // credential that can write to the private bucket, so it must not become a
  // general-purpose upload for anything that reaches it.
  if (!/^index\/[\w.-]+\/[\w.-]+$/.test(key)) {
    throw new HttpError(400, 'Key must look like index/<event>/<shard>', 'bad_key');
  }
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) throw new HttpError(400, 'Empty shard', 'bad_request');
  await c.env.INDEX_BUCKET.put(key, body, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  return c.json({ ok: true, key, bytes: body.byteLength });
});

/**
 * Compact an event's face shards into a single R2 object.
 *
 * The indexer writes one shard per BATCH of 25 photos, so a large album accumulates
 * a thousand of them — Angkor had 1006 at 81 KB average — and the count grows with
 * every continuation pass, because run_id is fresh per invocation. Every cold face
 * search then issues that many R2 GETs, which is the ~1 s loadMs floor measured in
 * production and three orders of magnitude more class-B operations than one read.
 *
 * WHY THIS IS A SEPARATE PASS AND NOT PART OF THE WRITE PATH
 *
 * The per-batch flush is the durability guarantee: it is what makes an interrupted
 * run recoverable rather than losing every embedding it had computed. Compaction
 * must not weaken it, so it runs after the fact and leaves the write path alone.
 * Until the D1 swap at the very end, nothing here is observable — fail anywhere
 * earlier and the per-batch shards remain authoritative.
 *
 * WHY faces.row_idx NEEDS NO MIGRATION
 *
 * Concatenating in row_base order preserves global row order exactly, so every
 * existing row_idx -> byte offset mapping stays valid. That is what makes this cheap
 * enough to be worth doing at all.
 *
 * Body: { dry_run?: boolean, delete_old?: boolean }
 */
internalRoutes.post('/events/:id/compact', async (c) => {
  const eventId = c.req.param('id');
  const { dry_run: dryRun, delete_old: deleteOld } =
    await c.req.json<{ dry_run?: boolean; delete_old?: boolean }>().catch(() => ({} as any));

  const { results: shards } = await c.env.DB.prepare(
    'SELECT shard_key, row_base, row_count FROM face_shards WHERE event_id = ? ORDER BY row_base',
  ).bind(eventId).all<{ shard_key: string; row_base: number; row_count: number }>();
  if (!shards.length) throw new HttpError(404, 'No shards for that event', 'no_shards');
  if (shards.length === 1) {
    return c.json({ ok: true, skipped: 'already a single shard', shards: 1 });
  }

  // The rows must tile [0, total) exactly. A gap or an overlap would shift every row
  // after it, silently repointing thousands of faces at the wrong vector — the kind
  // of corruption that shows up as "search returns strangers" weeks later.
  let expectedBase = 0;
  for (const s of shards) {
    if (s.row_base !== expectedBase) {
      throw new HttpError(
        409,
        `Shards are not contiguous: expected row_base ${expectedBase}, found ${s.row_base} ` +
          `at ${s.shard_key}. Refusing to compact.`,
        'not_contiguous',
      );
    }
    if (!Number.isInteger(s.row_count) || s.row_count <= 0) {
      throw new HttpError(409, `Bad row_count on ${s.shard_key}`, 'bad_row_count');
    }
    expectedBase += s.row_count;
  }
  const totalRows = expectedBase;
  const totalBytes = totalRows * DIM;

  // Verify every object exists and is exactly its declared size BEFORE writing
  // anything. loadIndex tolerates a short shard by taking what is there and leaving
  // the rest zeroed, which is right for a live search — one bad source should not
  // break the event. It is wrong here: compaction would bake those zeros in
  // permanently, where today re-uploading the shard still fixes it. So this aborts
  // and names the offenders instead of quietly making the loss durable.
  const bad: { key: string; expected: number; actual: number | null }[] = [];
  for (const part of chunk(shards, 32)) {
    const heads = await Promise.all(
      part.map(async (s) => ({ s, head: await c.env.INDEX_BUCKET.head(s.shard_key) })),
    );
    for (const { s, head } of heads) {
      const expected = s.row_count * DIM;
      if (!head) bad.push({ key: s.shard_key, expected, actual: null });
      else if (head.size !== expected) bad.push({ key: s.shard_key, expected, actual: head.size });
    }
  }
  if (bad.length) {
    throw new HttpError(
      409,
      `${bad.length} shard(s) missing or the wrong size; refusing to compact. ` +
        bad.slice(0, 5).map((b) => `${b.key} expected ${b.expected} got ${b.actual ?? 'MISSING'}`).join('; '),
      'bad_shards',
    );
  }

  if (dryRun) {
    return c.json({
      ok: true, dry_run: true, shards: shards.length,
      rows: totalRows, bytes: totalBytes, contiguous: true, all_present: true,
    });
  }

  // Streamed as a multipart upload so peak memory is one part, not the whole index.
  // 82 MB buffered in a 128 MB isolate is how the loadIndex bug happened; there is no
  // reason to repeat it here.
  //
  // FIXED-SIZE parts, and this is not a style choice: R2 rejects
  // completeMultipartUpload with "All non-trailing parts must have the same length"
  // (10048). That is stricter than S3, which only requires >= 5 MB. Accumulating
  // whole shards until a 5 MB threshold produced parts of differing sizes and failed
  // at the very last call, after streaming all 83 MB. So the shards are treated as one
  // byte stream and cut at exact PART_SIZE boundaries, which means a shard can and
  // will straddle two parts.
  const PART_SIZE = 8 * 1024 * 1024;
  const key = `index/${eventId}/compact-${newId(8)}.bin`;
  const upload = await c.env.INDEX_BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });

  const uploaded: R2UploadedPart[] = [];
  let part = new Uint8Array(PART_SIZE);
  let filled = 0;
  let written = 0;

  const flushFull = async () => {
    uploaded.push(await upload.uploadPart(uploaded.length + 1, part));
    written += PART_SIZE;
    part = new Uint8Array(PART_SIZE);
    filled = 0;
  };

  try {
    for (const s of shards) {
      const obj = await c.env.INDEX_BUCKET.get(s.shard_key);
      if (!obj) throw new Error(`${s.shard_key} vanished mid-compaction`);
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (bytes.length !== s.row_count * DIM) {
        throw new Error(`${s.shard_key} changed size mid-compaction`);
      }
      let at = 0;
      while (at < bytes.length) {
        const room = PART_SIZE - filled;
        const take = Math.min(room, bytes.length - at);
        part.set(bytes.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === PART_SIZE) await flushFull();
      }
    }
    // The trailing part is the only one allowed a different length.
    if (filled > 0) {
      uploaded.push(await upload.uploadPart(uploaded.length + 1, part.subarray(0, filled)));
      written += filled;
    }

    if (written !== totalBytes) {
      throw new Error(`assembled ${written} bytes, expected ${totalBytes}`);
    }
    await upload.complete(uploaded);

    const head = await c.env.INDEX_BUCKET.head(key);
    if (!head || head.size !== totalBytes) {
      throw new Error(`compact object is ${head?.size ?? 'missing'}, expected ${totalBytes}`);
    }
  } catch (err) {
    // Nothing is referenced yet, so abandoning the upload leaves the event exactly as
    // it was, still served by its per-batch shards.
    await upload.abort().catch(() => {});
    throw new HttpError(500, `Compaction failed, nothing changed: ${(err as Error).message}`, 'compact_failed');
  }

  // The only observable moment. One batch, so a reader either sees the thousand rows
  // or the one — never a mixture, which would double-count every row.
  const oldKeys = shards.map((s) => s.shard_key);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM face_shards WHERE event_id = ?').bind(eventId),
    c.env.DB.prepare(
      'INSERT INTO face_shards (event_id, shard_key, row_base, row_count) VALUES (?, ?, 0, ?)',
    ).bind(eventId, key, totalRows),
  ]);
  invalidateIndex(eventId);

  // Off by default. The originals are unreferenced now, so keeping them costs a
  // little storage and buys a way back if the compact object turns out wrong.
  let deleted = 0;
  if (deleteOld) {
    for (const part of chunk(oldKeys, 100)) {
      await c.env.INDEX_BUCKET.delete(part);
      deleted += part.length;
    }
  }

  return c.json({
    ok: true, key, rows: totalRows, bytes: totalBytes,
    shards_before: shards.length, parts: uploaded.length,
    old_objects_deleted: deleted, old_objects_kept: deleteOld ? 0 : oldKeys.length,
  });
});
