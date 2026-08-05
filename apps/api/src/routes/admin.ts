import { Hono } from 'hono';
import type { Env, EventRow, JobRow } from '../types';
import { HttpError, newId, nowIso, publicEvent, r2Url, slugify } from '../lib';
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
  const sourceId = newId();
  const jobId = newId();
  const ts = nowIso();

  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO sources (id, event_id, drive_folder_id, drive_url, added_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(sourceId, event_id, folderId, drive_url, ts),
    c.env.DB.prepare(
      'INSERT INTO jobs (id, event_id, source_id, status, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(jobId, event_id, sourceId, 'queued', ts),
    c.env.DB.prepare("UPDATE events SET status = 'indexing' WHERE id = ?").bind(event_id),
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
