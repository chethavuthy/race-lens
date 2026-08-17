import { Hono } from 'hono';
import type { Env, EventRow } from '../types';
import { clampLimit, clampThreshold, HttpError, publicEvent, publicPhoto } from '../lib';
import { searchFaces } from '../search';
import { PREFIX_SEP, bibDigits, bibPrefix, normalizeBib } from '../bib';

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

/**
 * Photos whose source has been withdrawn are gone from the public site at once.
 *
 * DELETE /api/admin/sources/:id deletes the photo rows too, but it does that in
 * batches — a 5,000-photo album is several requests' worth of work. This clause is
 * what makes the promise on the event page true from the first one: the moment
 * removed_at is set, nothing from that link can be browsed, paged, or searched,
 * whatever is left to purge.
 */
const NOT_REMOVED =
  'AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.removed_at IS NOT NULL)';

publicRoutes.get('/events/:slug', async (c) => {
  const event = await getEventBySlug(c.env, c.req.param('slug'));
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.drive_file_id, p.thumb_key, p.width, p.height, p.taken_at
       FROM photos p WHERE p.event_id = ? ${NOT_REMOVED} ORDER BY p.id LIMIT 60`,
  ).bind(event.id).all<any>();

  // Who shot what. One row per live source, biggest contribution first, so the
  // page can name them in the order that matches how much of the album is theirs.
  const { results: credits } = await c.env.DB.prepare(
    `SELECT s.credit_name AS name, s.drive_url AS album_url,
            (SELECT COUNT(*) FROM photos p WHERE p.source_id = s.id) AS photo_count
       FROM sources s
      WHERE s.event_id = ? AND s.removed_at IS NULL
      ORDER BY photo_count DESC, s.added_at`,
  ).bind(event.id).all<{ name: string | null; album_url: string; photo_count: number }>();

  return c.json({
    event: publicEvent(c.env, event),
    photos: results.map((p) => publicPhoto(c.env, p)),
    cursor: results.length === 60 ? results[results.length - 1].id : null,
    // A source that indexed nothing yet is not a credit — there is no work of
    // theirs on the page to credit.
    credits: credits.filter((cr) => cr.photo_count > 0),
  });
});

publicRoutes.get('/events/:slug/photos', async (c) => {
  const event = await getEventBySlug(c.env, c.req.param('slug'));
  const limit = clampLimit(c.req.query('limit'), 60, 200);
  const cursor = c.req.query('cursor') ?? '';
  // Keyset pagination on the primary key — stable and index-only.
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.drive_file_id, p.thumb_key, p.width, p.height, p.taken_at
       FROM photos p WHERE p.event_id = ? AND p.id > ? ${NOT_REMOVED} ORDER BY p.id LIMIT ?`,
  ).bind(event.id, cursor, limit).all<any>();
  return c.json({
    photos: results.map((p) => publicPhoto(c.env, p)),
    cursor: results.length === limit ? results[results.length - 1].id : null,
  });
});

publicRoutes.get('/events/:slug/bib/:bib', async (c) => {
  const event = await getEventBySlug(c.env, c.req.param('slug'));
  // Enforced here, not only in the UI: an event with no bibs may still hold bib
  // rows from before the organizer turned the flag off, and a hidden search box
  // is not the same as an unavailable one.
  if (event.bibs_enabled === 0) {
    throw new HttpError(404, 'This event does not use bib numbers', 'no_bibs');
  }
  // normalizeBib, not a bare digit strip: at a race that numbers by category the
  // letter is part of WHICH RUNNER this is, so "F-0001" must resolve to 'F-1' and
  // not to '1', which belongs to somebody else. Mirrors indexer/bibs.py.
  const bib = normalizeBib(c.req.param('bib'));
  if (!bib) return c.json({ photos: [], matched: null });
  const digits = bibDigits(bib);

  const select = `SELECT p.id, p.drive_file_id, p.thumb_key, p.width, p.height, p.taken_at,
                         b.conf, b.bib, b.bib_raw
                    FROM bibs b JOIN photos p ON p.id = b.photo_id
                   WHERE b.event_id = ? ${NOT_REMOVED}`;

  // Exact match on the normalized number. Both sides strip leading zeros, so
  // "0056", "056" and "56" all resolve to the same runner.
  let matched: 'exact' | 'suffix' = 'exact';
  let { results } = await c.env.DB.prepare(`${select} AND b.bib = ? ORDER BY b.conf DESC LIMIT 200`)
    .bind(event.id, bib).all<any>();

  // Suffix matching is OPT-IN (?fuzzy=1), never the default.
  //
  // It was the default, to recover bibs whose leading digit OCR missed. But
  // `LIKE '%56'` also matches 956, 1056, 2256 — so a runner searching their own
  // number was shown strangers' photos and had no way to tell. Returning the
  // wrong person's race photos is worse than returning none: the runner cannot
  // verify it, and the whole product is "find MY photos".
  //
  // Scoped to the same category, which matters now that a stored bib may carry a
  // prefix: a bare LIKE '%1' matches '21' and 'F-1' and 'M-1' alike, so widening
  // the search for a marathon runner would hand them two 10k runners' photos —
  // the exact cross-runner leak the paragraph above is about, reintroduced by the
  // prefix rather than by a missing digit.
  const fuzzy = c.req.query('fuzzy') === '1';
  if (results.length === 0 && fuzzy) {
    matched = 'suffix';
    const prefix = bibPrefix(bib);
    const r = prefix
      ? await c.env.DB.prepare(
          `${select} AND b.bib LIKE ? ORDER BY b.conf DESC LIMIT 200`)
          .bind(event.id, `${prefix}${PREFIX_SEP}%${digits}`).all<any>()
        // A bare number stays bare: NOT LIKE '%-%' keeps prefixed bibs out.
      : await c.env.DB.prepare(
          `${select} AND b.bib LIKE ? AND b.bib NOT LIKE ? ORDER BY b.conf DESC LIMIT 200`)
          .bind(event.id, `%${digits}`, `%${PREFIX_SEP}%`).all<any>();
    results = r.results;
  }

  // Collapse to one row per photo — a group shot holds many bibs, and the same
  // number can be read on two faces in it.
  const seen = new Set<string>();
  const photos = results.filter((r: any) => !seen.has(r.id) && seen.add(r.id));

  // Other categories carrying the SAME digits — offered, never merged.
  //
  // At a mixed race a 10k runner may well type "0001" without their letter and
  // land on the marathon runner's photos, or on nothing. Folding all three
  // together instead would show every runner two strangers, with no way to tell
  // which photos are theirs. So the alternatives are returned as labels for the
  // UI to offer as a next step, and the results stay exactly one runner's.
  //
  // Stored labels are either 'D' or 'P-D', so same-digits means bib = digits or
  // bib LIKE '%-digits'. Cheap: one indexed lookup on (event_id, bib).
  const { results: sameDigits } = await c.env.DB.prepare(
    `SELECT DISTINCT bib FROM bibs
      WHERE event_id = ? AND (bib = ? OR bib LIKE ?) AND bib <> ? LIMIT 10`,
  ).bind(event.id, digits, `%${PREFIX_SEP}${digits}`, bib).all<{ bib: string }>();

  return c.json({
    matched: photos.length ? matched : null,
    /** The bib actually searched, canonicalized — 'F-1' for a typed "f 0001". */
    bib: bib,
    /**
     * Same number, different category. Labels only; the UI offers them rather
     * than mixing their photos in.
     */
    alternatives: sameDigits.map((r) => r.bib),
    // What was actually printed on the bib we matched, so the UI can show the
    // runner why a photo came back.
    bib_read: photos[0]?.bib_raw ?? null,
    photos: photos.map((p: any) => publicPhoto(c.env, p)),
    // Offered only when an exact search found nothing, so the UI can present
    // widening as a deliberate choice rather than doing it silently.
    fuzzy_available: photos.length === 0 && !fuzzy,
  });
});

publicRoutes.post('/events/:slug/search/face', async (c) => {
  const event = await getEventBySlug(c.env, c.req.param('slug'));
  const body = await c.req.json<{ vec?: unknown }>().catch(() => ({} as any));
  const vec = body.vec;
  if (!Array.isArray(vec) || vec.length !== 512 || !vec.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new HttpError(400, 'Body must be { vec: number[512] } of finite numbers', 'bad_vec');
  }
  const { matches, timing } = await searchFaces(c.env, event.id, vec as number[], {
    // Clamped, not merely finite: ?t=-1 made the cutoff negative, which turns every
    // row in the index into a candidate and forces a full sort of them — and
    // anything near 0 returns strangers, on the one search that must not.
    threshold: clampThreshold(c.req.query('t'), 0.38),
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
