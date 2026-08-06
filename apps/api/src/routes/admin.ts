import { Hono } from 'hono';
import type { Env, EventRow, JobRow } from '../types';
import { chunk, HttpError, newId, nowIso, publicEvent, publicPhoto, r2Url, slugify } from '../lib';
import { parseFolderId, sampleThumbUrl, walkFolder } from '../drive';

export const adminRoutes = new Hono<{ Bindings: Env }>();

/**
 * Defense in depth behind Cloudflare Access. Access itself is the real gate
 * (configured on the /api/admin/* route in the dashboard); this only refuses
 * requests that never passed through it — e.g. if someone points a hostname at
 * the Worker without an Access policy attached. We deliberately do not verify
 * the JWT signature here: that is Access's job, and re-implementing it badly is
 * worse than not doing it.
 */
adminRoutes.use('*', async (c, next) => {
  const assertion = c.req.header('Cf-Access-Jwt-Assertion');
  // Bypass is a deploy-time var, never a request header: a header-triggered
  // bypass is trivially forgeable by anyone who finds the Worker's origin.
  const devBypass = c.env.DEV_ADMIN_BYPASS === '1';
  if (!assertion && !devBypass) {
    throw new HttpError(403, 'Admin requires Cloudflare Access', 'no_access');
  }
  await next();
});

/** Validate a pasted Drive link. Deliberately does NOT start a job. */
adminRoutes.post('/drive/inspect', async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }));
  if (!url) throw new HttpError(400, 'Missing url', 'bad_request');

  const folderId = parseFolderId(url);
  const { images, subfolders, truncated } = await walkFolder(c.env.GOOGLE_API_KEY, folderId);

  if (images.length === 0) {
    throw new HttpError(
      404,
      'That folder is reachable but contains no images. If the photos live in a Shared Drive, check that the link points at the folder itself and not a search result.',
      'empty',
    );
  }

  return c.json({
    folder_id: folderId,
    image_count: images.length,
    subfolder_count: subfolders.length,
    subfolders: subfolders.slice(0, 20),
    truncated,
    samples: images.slice(0, 4).map((f) => ({ id: f.id, name: f.name, thumb: sampleThumbUrl(f.id) })),
  });
});

adminRoutes.get('/events', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM events ORDER BY created_at DESC',
  ).all<EventRow>();
  return c.json({ events: results.map((e) => ({ ...publicEvent(c.env, e), created_at: e.created_at })) });
});

adminRoutes.post('/events', async (c) => {
  const body = await c.req.json<{ name?: string; event_date?: string; slug?: string }>();
  const name = (body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'name is required', 'bad_request');

  const slug = slugify(body.slug || name);
  if (!slug) throw new HttpError(400, 'Could not derive a slug from that name', 'bad_slug');

  const existing = await c.env.DB.prepare('SELECT id FROM events WHERE slug = ?').bind(slug).first();
  if (existing) throw new HttpError(409, `Slug "${slug}" is already taken`, 'dup_slug');

  const id = newId();
  await c.env.DB.prepare(
    'INSERT INTO events (id, slug, name, event_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, slug, name, body.event_date ?? null, 'draft', nowIso()).run();

  const row = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
  return c.json({ event: publicEvent(c.env, row!) }, 201);
});

adminRoutes.patch('/events/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; event_date?: string; status?: string }>();
  const allowed = ['draft', 'indexing', 'ready', 'partial'];
  if (body.status && !allowed.includes(body.status)) {
    throw new HttpError(400, 'Invalid status', 'bad_status');
  }
  await c.env.DB.prepare(
    `UPDATE events SET name = COALESCE(?, name),
                       event_date = COALESCE(?, event_date),
                       status = COALESCE(?, status)
      WHERE id = ?`,
  ).bind(body.name ?? null, body.event_date ?? null, body.status ?? null, id).run();
  const row = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
  if (!row) throw new HttpError(404, 'Event not found', 'no_event');
  return c.json({ event: publicEvent(c.env, row) });
});

adminRoutes.post('/events/:id/banner', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  const file = form.get('file') as unknown as File | string | null;
  // `instanceof File` does not narrow under @cloudflare/workers-types, so duck-type.
  if (!file || typeof file === 'string' || typeof file.stream !== 'function') {
    throw new HttpError(400, 'Expected multipart field "file"', 'bad_request');
  }
  if (!file.type.startsWith('image/')) throw new HttpError(400, 'Banner must be an image', 'bad_type');
  if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'Banner must be under 8 MB', 'too_large');

  const key = `banners/${id}.webp`;
  await c.env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
  });
  await c.env.DB.prepare('UPDATE events SET banner_key = ? WHERE id = ?').bind(key, id).run();
  return c.json({ banner_url: r2Url(c.env, key) });
});

/** Bind a Drive folder to an event and fire the CI indexing job. */
adminRoutes.post('/ingest', async (c) => {
  const { event_id, drive_url } = await c.req.json<{ event_id?: string; drive_url?: string }>();
  if (!event_id || !drive_url) throw new HttpError(400, 'event_id and drive_url are required', 'bad_request');

  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(event_id).first<EventRow>();
  if (!event) throw new HttpError(404, 'Event not found', 'no_event');

  const folderId = parseFolderId(drive_url);
  const ts = nowIso();

  // Re-use the source when this folder is already bound to this event.
  //
  // Every ingest used to insert a new row, so pasting the same link twice — or
  // re-running after a rate limit — produced duplicate sources for one folder.
  // The admin page then listed the same link several times, most with zero
  // photos, and any per-source total became nonsense.
  const existing = await c.env.DB.prepare(
    'SELECT id FROM sources WHERE event_id = ? AND drive_folder_id = ?',
  ).bind(event_id, folderId).first<{ id: string }>();

  const sourceId = existing?.id ?? newId();
  const jobId = newId();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO sources (id, event_id, drive_folder_id, drive_url, added_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (event_id, drive_folder_id) DO UPDATE SET drive_url = excluded.drive_url`,
    ).bind(sourceId, event_id, folderId, drive_url, ts),
    c.env.DB.prepare(
      'INSERT INTO jobs (id, event_id, source_id, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(jobId, event_id, sourceId, 'queued', ts),
    // Only a draft becomes 'indexing'. An event that is already published must
    // STAY published while more photos are added: 'indexing' is excluded from
    // GET /api/events, so flipping a live event would pull it off the site and
    // 404 its page for every runner until the job finished — for an operation
    // that is purely additive.
    c.env.DB.prepare(
      "UPDATE events SET status = 'indexing' WHERE id = ? AND status = 'draft'",
    ).bind(event_id),
  ]);

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
      client_payload: { event_id, source_id: sourceId, folder_id: folderId, job_id: jobId },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    // Mark the job failed immediately rather than leaving the admin UI
    // polling a job that no runner will ever pick up.
    await c.env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
    ).bind(`dispatch failed: ${res.status} ${detail.slice(0, 300)}`, nowIso(), jobId).run();
    throw new HttpError(502, `Could not start the indexing job (GitHub returned ${res.status})`, 'dispatch_failed');
  }

  return c.json({ job_id: jobId, source_id: sourceId, folder_id: folderId }, 202);
});

/**
 * Everything the organizer needs to answer "why is my album short?" without
 * access to CI logs: every link bound to the event, what each one found versus
 * what actually landed, and the reason for each miss.
 */
adminRoutes.get('/events/:id/report', async (c) => {
  const eventId = c.req.param('id');

  const { results: sources } = await c.env.DB.prepare(
    `SELECT s.id, s.drive_folder_id, s.drive_url, s.discovered, s.added_at,
            (SELECT COUNT(*) FROM photos p WHERE p.source_id = s.id) AS indexed
       FROM sources s WHERE s.event_id = ? ORDER BY s.added_at`,
  ).bind(eventId).all<any>();

  const { results: rawJobs } = await c.env.DB.prepare(
    `SELECT id, source_id, status, done, total, skipped, attempts, error, updated_at
       FROM jobs WHERE event_id = ? ORDER BY updated_at DESC`,
  ).bind(eventId).all<any>();

  // A runner can vanish — GitHub cancels or reclaims it — and then nothing ever
  // moves the row off 'queued'/'running'. The page then reports "a pass is
  // running" forever, which is worse than reporting nothing: it hides the
  // Re-index button behind a state that will never end. Anything untouched for
  // 20 minutes is treated as stalled.
  const STALE_MS = 20 * 60 * 1000;
  const now = Date.now();
  const jobs = rawJobs.map((j) => ({
    ...j,
    stale: ['queued', 'running'].includes(j.status) &&
           now - Date.parse(j.updated_at) > STALE_MS,
  }));

  const { results: log } = await c.env.DB.prepare(
    `SELECT level, code, message, drive_file_id, source_id, created_at
       FROM ingest_log WHERE event_id = ? ORDER BY id DESC LIMIT 300`,
  ).bind(eventId).all<any>();

  const { results: counts } = await c.env.DB.prepare(
    `SELECT level, code, COUNT(*) AS n FROM ingest_log
      WHERE event_id = ? GROUP BY level, code ORDER BY n DESC`,
  ).bind(eventId).all<any>();

  // Quality stats. Coverage alone does not tell the organizer whether SEARCH
  // works — an album can be 100% indexed and still be unusable if OCR read no
  // bibs or the detector found no faces.
  const q = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM photos WHERE event_id = ?1) AS photos,
       (SELECT COUNT(*) FROM faces  WHERE event_id = ?1) AS faces,
       (SELECT COUNT(DISTINCT photo_id) FROM faces WHERE event_id = ?1) AS photos_with_face,
       (SELECT COUNT(DISTINCT photo_id) FROM bibs  WHERE event_id = ?1) AS photos_with_bib,
       (SELECT COUNT(DISTINCT bib) FROM bibs WHERE event_id = ?1) AS distinct_bibs`,
  ).bind(eventId).first<any>();

  const { results: topBibs } = await c.env.DB.prepare(
    `SELECT COALESCE(bib_raw, bib) AS bib, COUNT(*) AS n FROM bibs
      WHERE event_id = ? GROUP BY bib ORDER BY n DESC LIMIT 12`,
  ).bind(eventId).all<any>();

  // Event-wide truth, not a sum of per-source rows: photo_count on events is
  // only refreshed at the end of a pass, so it reads stale while one is running.
  const live = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM photos WHERE event_id = ?',
  ).bind(eventId).first<{ n: number }>();

  const withMissing = sources.map((s) => ({
    ...s,
    // discovered is 0 for sources indexed before it was recorded. Zero is not
    // "found nothing", it is "not known" — reporting it as a shortfall invented
    // missing photos that did not exist.
    discovered_known: (s.discovered ?? 0) > 0,
    missing: (s.discovered ?? 0) > 0 ? Math.max(0, s.discovered - (s.indexed ?? 0)) : 0,
  }));

  return c.json({
    sources: withMissing,
    totals: {
      links: withMissing.length,
      found: withMissing.reduce((n, s) => n + (s.discovered_known ? s.discovered : 0), 0),
      found_known: withMissing.every((s) => s.discovered_known),
      indexed: live?.n ?? 0,
      missing: withMissing.reduce((n, s) => n + s.missing, 0),
    },
    quality: {
      photos: q?.photos ?? 0,
      faces: q?.faces ?? 0,
      photos_with_face: q?.photos_with_face ?? 0,
      photos_with_bib: q?.photos_with_bib ?? 0,
      distinct_bibs: q?.distinct_bibs ?? 0,
      photos_without_face: Math.max(0, (q?.photos ?? 0) - (q?.photos_with_face ?? 0)),
      photos_without_bib: Math.max(0, (q?.photos ?? 0) - (q?.photos_with_bib ?? 0)),
    },
    top_bibs: topBibs,
    jobs, log, summary: counts,
  });
});

/** Re-run one source: a fresh job over the same folder. Resume skips what exists. */
adminRoutes.post('/sources/:id/reindex', async (c) => {
  const sourceId = c.req.param('id');
  const src = await c.env.DB.prepare('SELECT * FROM sources WHERE id = ?').bind(sourceId).first<any>();
  if (!src) throw new HttpError(404, 'Source not found', 'no_source');

  const jobId = newId();
  await c.env.DB.prepare(
    'INSERT INTO jobs (id, event_id, source_id, status, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(jobId, src.event_id, sourceId, 'queued', nowIso()).run();

  const res = await fetch(`https://api.github.com/repos/${c.env.GH_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'race-lens-worker', 'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'index-event',
      client_payload: {
        event_id: src.event_id, source_id: sourceId,
        folder_id: src.drive_folder_id, job_id: jobId,
      },
    }),
  });
  if (!res.ok) {
    await c.env.DB.prepare("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?")
      .bind(`dispatch failed: ${res.status}`, nowIso(), jobId).run();
    throw new HttpError(502, `Could not start the job (GitHub ${res.status})`, 'dispatch_failed');
  }
  return c.json({ job_id: jobId }, 202);
});

adminRoutes.get('/events/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?')
    .bind(c.req.param('id')).first<EventRow>();
  if (!row) throw new HttpError(404, 'Event not found', 'no_event');
  return c.json({ event: { ...publicEvent(c.env, row), created_at: row.created_at } });
});

/**
 * Photos with their detected faces and read bibs, for visual debugging.
 *
 * Boxes are returned as fractions of the image, not pixels: they were detected
 * on the 6000px original but are drawn over a 1000px thumbnail, so anything
 * absolute would be six times too big.
 */
adminRoutes.get('/events/:id/photos', async (c) => {
  const eventId = c.req.param('id');
  const limit = Math.min(Number(c.req.query('limit') ?? 24) || 24, 60);
  const cursor = c.req.query('cursor') ?? '';
  const filter = c.req.query('filter') ?? 'all'; // all | no_face | no_bib | has_bib

  const where =
    filter === 'no_face' ? 'AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = p.id)'
    : filter === 'no_bib' ? 'AND NOT EXISTS (SELECT 1 FROM bibs b WHERE b.photo_id = p.id)'
    : filter === 'has_bib' ? 'AND EXISTS (SELECT 1 FROM bibs b WHERE b.photo_id = p.id)'
    : '';

  const { results: photos } = await c.env.DB.prepare(
    `SELECT p.id, p.drive_file_id, p.thumb_key, p.width, p.height
       FROM photos p WHERE p.event_id = ? AND p.id > ? ${where}
      ORDER BY p.id LIMIT ?`,
  ).bind(eventId, cursor, limit).all<any>();

  if (!photos.length) return c.json({ photos: [], cursor: null });

  const ids = photos.map((p: any) => p.id);
  const faces: any[] = [];
  const bibs: any[] = [];
  for (const part of chunk(ids, 90)) {
    const ph = part.map(() => '?').join(',');
    const f = await c.env.DB.prepare(
      `SELECT photo_id, bbox, bib FROM faces WHERE photo_id IN (${ph})`).bind(...part).all<any>();
    faces.push(...f.results);
    const b = await c.env.DB.prepare(
      `SELECT photo_id, COALESCE(bib_raw, bib) AS bib, bib AS bib_key, conf, source
         FROM bibs WHERE photo_id IN (${ph})`,
    ).bind(...part).all<any>();
    bibs.push(...b.results);
  }

  const byPhoto = (rows: any[]) => rows.reduce((m: any, r: any) => {
    (m[r.photo_id] ??= []).push(r); return m;
  }, {});
  const fMap = byPhoto(faces);
  const bMap = byPhoto(bibs);

  return c.json({
    photos: photos.map((p: any) => {
      const w = p.width || 1, h = p.height || 1;
      return {
        ...publicPhoto(c.env, p),
        faces: (fMap[p.id] ?? []).map((f: any) => {
          const [x, y, bw, bh] = JSON.parse(f.bbox);
          return {
            bib: f.bib,
            // clamped: a box can sit a pixel or two outside after rounding
            x: Math.max(0, Math.min(1, x / w)), y: Math.max(0, Math.min(1, y / h)),
            w: Math.max(0, Math.min(1, bw / w)), h: Math.max(0, Math.min(1, bh / h)),
          };
        }),
        bibs: (bMap[p.id] ?? []).map((b: any) => ({
          bib: b.bib, bib_key: b.bib_key, conf: b.conf, source: b.source ?? 'ocr',
        })),
      };
    }),
    cursor: photos.length === limit ? photos[photos.length - 1].id : null,
  });
});

/**
 * Manual bib entry and correction.
 *
 * OCR has a measured ceiling on mid-distance and partly-occluded bibs, and a
 * single wrong digit makes a runner unfindable. These rows carry source =
 * 'manual', which the indexer's replace path never deletes, so a correction
 * outlives every future re-index.
 */
adminRoutes.post('/photos/:id/bibs', async (c) => {
  const photoId = c.req.param('id');
  const { bib } = await c.req.json<{ bib?: string }>();

  const raw = String(bib ?? '').trim().replace(/\D/g, '');
  if (!raw || raw.length > 5) {
    throw new HttpError(400, 'Enter a bib number of 1-5 digits', 'bad_bib');
  }
  // Same normalisation as search and the indexer: leading zeros stripped for
  // matching, printed form kept for display.
  const norm = raw.replace(/^0+(?=\d)/, '');

  const photo = await c.env.DB.prepare('SELECT event_id FROM photos WHERE id = ?')
    .bind(photoId).first<{ event_id: string }>();
  if (!photo) throw new HttpError(404, 'Photo not found', 'no_photo');

  await c.env.DB.prepare(
    `INSERT INTO bibs (event_id, bib, photo_id, conf, bib_raw, source)
     VALUES (?, ?, ?, 1.0, ?, 'manual')
     ON CONFLICT (event_id, bib, photo_id) DO UPDATE SET
       conf = 1.0, bib_raw = excluded.bib_raw, source = 'manual'`,
  ).bind(photo.event_id, norm, photoId, raw).run();

  return c.json({ ok: true, bib: norm, bib_raw: raw });
});

adminRoutes.delete('/photos/:id/bibs/:bib', async (c) => {
  const photoId = c.req.param('id');
  const digits = c.req.param('bib').replace(/\D/g, '');
  const norm = digits.replace(/^0+(?=\d)/, '');
  const photo = await c.env.DB.prepare('SELECT event_id FROM photos WHERE id = ?')
    .bind(photoId).first<{ event_id: string }>();
  if (!photo) throw new HttpError(404, 'Photo not found', 'no_photo');

  // A deleted OCR read would come straight back on the next re-index, so record
  // the removal as a manual tombstone rather than just dropping the row.
  await c.env.DB.prepare(
    'DELETE FROM bibs WHERE event_id = ? AND photo_id = ? AND bib = ?',
  ).bind(photo.event_id, photoId, norm).run();

  await c.env.DB.prepare(
    `INSERT INTO bib_rejects (event_id, photo_id, bib, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (event_id, photo_id, bib) DO NOTHING`,
  ).bind(photo.event_id, photoId, norm, nowIso()).run();

  return c.json({ ok: true, removed: norm });
});

adminRoutes.get('/jobs/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(c.req.param('id')).first<JobRow>();
  if (!row) throw new HttpError(404, 'Job not found', 'no_job');
  return c.json({ job: row });
});

adminRoutes.get('/events/:id/jobs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM jobs WHERE event_id = ? ORDER BY updated_at DESC LIMIT 20',
  ).bind(c.req.param('id')).all<JobRow>();
  return c.json({ jobs: results });
});
