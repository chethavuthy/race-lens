import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, EventRow, JobRow } from '../types';
import { chunk, clampLimit, HttpError, newId, nowIso, publicEvent, publicPhoto, r2Url, slugify } from '../lib';
import { PREFIX_SEP, normalizeBib, parsePrefixes } from '../bib';
import { bannerKey, bannerType } from '../banner';
import { faceBox } from '../bbox';
import { parseFolderId, sampleThumbUrl, walkFolder } from '../drive';
import { onAccessHost, verifyAccessJwt } from '../access';

/**
 * `owner` separates the two people who reach these routes.
 *
 * The operator runs the service. A photographer was let through the Access list
 * to index their own album and nothing more — so the settings that only make
 * sense to someone watching Drive's limits are decided for them rather than
 * offered, here and not only in the UI. A hidden control is not a rule.
 */
export const adminRoutes = new Hono<{
  Bindings: Env;
  Variables: { owner: boolean; email: string | null };
}>();

/**
 * Cloudflare Access is the real gate. This refuses anything it did not cover.
 *
 * Two checks, and the hostname one is not decoration. Access cannot be attached to
 * a workers.dev
 * hostname (it needs a zone we own), that origin is published in the browser bundle
 * and in DEPLOY.md, and `workers_dev = true` keeps it live for *.pages.dev browsing.
 * So the old presence-only check on Cf-Access-Jwt-Assertion — a header any client
 * can set to any value — left every admin route wide open there:
 *
 *     curl -H 'Cf-Access-Jwt-Assertion: x' https://…workers.dev/api/admin/events
 *
 * Refusing by hostname costs nothing, because admin has never worked on that
 * origin: the Access cookie is host-scoped, so the SPA cannot authenticate
 * cross-origin against it either (DEPLOY.md:132).
 *
 * The assertion is verified, not merely detected: RS256 against the team JWKS,
 * with `aud`, `iss` and `exp` pinned. Access itself returns 302 on these paths
 * before the Worker runs, so this is the second of two independent layers — which
 * is the point, because the first one lives in a dashboard nothing here can assert.
 */
adminRoutes.use('*', async (c, next) => {
  let identity: string | null;

  // Bypass is a deploy-time var, never a request header: a header-triggered
  // bypass is trivially forgeable by anyone who finds the Worker's origin.
  if (c.env.DEV_ADMIN_BYPASS === '1') {
    // Local dev has no Access identity at all, so DEV_ADMIN_ROLE and
    // DEV_ADMIN_EMAIL stand in for one. Without them the operator-only half of
    // these routes, event ownership and bans are all untestable.
    identity = c.env.DEV_ADMIN_EMAIL ?? null;
  } else {
    if (!onAccessHost(c.env, c.req.url)) {
      throw new HttpError(403, 'Admin is not served on this hostname', 'no_access');
    }
    const claims = await verifyAccessJwt(c.env, c.req.header('Cf-Access-Jwt-Assertion'));
    if (!claims) throw new HttpError(403, 'Admin requires Cloudflare Access', 'no_access');
    identity = claims.email ?? null;
  }

  const email = (identity ?? '').toLowerCase();
  const owner = c.env.DEV_ADMIN_BYPASS === '1'
    ? c.env.DEV_ADMIN_ROLE !== 'photographer'
    : !!email && email === (c.env.OWNER_EMAIL ?? '').trim().toLowerCase();

  // THE authorization gate, not one of several.
  //
  // Cloudflare Access allows any verified email now, because the guest list
  // moved into this database so photographers can be added from /admin instead
  // of a dashboard. Access still proves the person owns the address; whether
  // that address may do anything is decided right here, and nowhere else.
  //
  // So it fails closed on every uncertainty: no row is a refusal, a banned row
  // is a refusal, and both are refused before a single route runs. This lives
  // OUTSIDE the dev-bypass branch on purpose — a check the dev environment
  // cannot execute is a check nobody can test, which is how the first version of
  // the ban shipped doing nothing locally.
  //
  // The operator is exempt from the lookup: locking yourself out of the only
  // account that can invite and unban is not a state worth being able to reach.
  if (!owner) {
    if (!email) throw new HttpError(403, 'No email on this identity', 'no_access');
    const row = await c.env.DB.prepare(
      'SELECT banned_at FROM organizers WHERE email = ?',
    ).bind(email).first<{ banned_at: string | null }>();
    if (!row) throw new HttpError(403, 'This account is not an organizer yet', 'not_invited');
    if (row.banned_at) throw new HttpError(403, 'This account no longer has access', 'banned');
  }

  c.set('owner', owner);
  c.set('email', identity);
  await next();
});

/** Who is signed in, and how much of this page they get. */
adminRoutes.get('/me', (c) => c.json({ email: c.get('email'), owner: c.get('owner') }));

type AdminCtx = Context<{ Bindings: Env; Variables: { owner: boolean; email: string | null } }>;

/** For the routes that are the operator's alone. */
function requireOwner(c: AdminCtx): void {
  if (!c.get('owner')) throw new HttpError(403, 'Not available on this account', 'not_owner');
}

/* ---------------------------------------------------------------- people --
   The guest list, and what each guest has published. This is the screen the
   invitation on /admin points at: a photographer messages on Telegram, the
   operator types their address here, and they are in. Only the operator can
   reach any of it. */

/** Enough of an address to be worth storing. Access verifies the rest. */
function cleanEmail(raw: string): string {
  const email = decodeURIComponent(raw ?? '').trim().toLowerCase();
  if (!email || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'That does not look like an email address', 'bad_email');
  }
  return email;
}

/** The operator's own address, which no route may ban or remove. */
const operatorEmail = (c: AdminCtx) => (c.env.OWNER_EMAIL ?? '').trim().toLowerCase();

/**
 * Everyone on the list, with what they have published beside them.
 *
 * The roster and the events are separate facts — someone can be invited and
 * never publish, or (from before this table existed) have published without a
 * row — so both are read and joined here rather than one being inferred from
 * the other. Anyone in either is listed; a person the operator cannot see is a
 * person they cannot remove.
 */
adminRoutes.get('/organizers', async (c) => {
  requireOwner(c);

  const [{ results: roster }, { results: stats }] = await Promise.all([
    c.env.DB.prepare(
      'SELECT email, added_at, banned_at, reason FROM organizers ORDER BY added_at DESC',
    ).all<{ email: string; added_at: string; banned_at: string | null; reason: string | null }>(),
    c.env.DB.prepare(
      `SELECT LOWER(owner_email) AS email,
              COUNT(*) AS events,
              COALESCE(SUM(photo_count), 0) AS photos,
              SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS published,
              MAX(created_at) AS last_event
         FROM events WHERE owner_email IS NOT NULL AND owner_email <> ''
        GROUP BY LOWER(owner_email)`,
    ).all<{ email: string; events: number; photos: number; published: number; last_event: string }>(),
  ]);

  const byEmail = new Map<string, any>();
  for (const r of roster) {
    byEmail.set(r.email, {
      email: r.email, added_at: r.added_at, banned_at: r.banned_at,
      events: 0, photos: 0, published: 0, last_event: null,
    });
  }
  for (const s of stats) {
    const row = byEmail.get(s.email) ?? {
      email: s.email, added_at: null, banned_at: null,
    };
    byEmail.set(s.email, {
      ...row,
      events: s.events, photos: s.photos, published: s.published, last_event: s.last_event,
    });
  }

  return c.json({ organizers: [...byEmail.values()] });
});

/**
 * Let a photographer in.
 *
 * Idempotent, and it un-bans: pressing Add on someone previously removed is a
 * decision to let them back, and refusing it in favour of a separate control
 * would only teach the operator that Add sometimes silently does nothing.
 */
adminRoutes.post('/organizers', async (c) => {
  requireOwner(c);
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = cleanEmail(body.email ?? '');

  await c.env.DB.prepare(
    `INSERT INTO organizers (email, added_at, added_by, banned_at, reason)
     VALUES (?, ?, ?, NULL, NULL)
     ON CONFLICT (email) DO UPDATE SET banned_at = NULL, reason = NULL`,
  ).bind(email, nowIso(), c.get('email')).run();

  return c.json({ email }, 201);
});

/**
 * Withdraw someone's access, and take down what they published.
 *
 * `unpublish` defaults to true: a removal that leaves the albums live is the
 * half-measure this replaces. Unpublishing hides the events from runners and
 * keeps every photo — letting them back in does NOT republish, because whether
 * an album belongs on the site is a separate judgement from whether a person
 * belongs on the list.
 */
adminRoutes.post('/organizers/:email/ban', async (c) => {
  requireOwner(c);
  const email = cleanEmail(c.req.param('email'));
  if (email === operatorEmail(c)) {
    throw new HttpError(400, 'That is the operator account', 'bad_request');
  }

  const body = await c.req.json<{ reason?: string; unpublish?: boolean }>()
    .catch(() => ({}) as { reason?: string; unpublish?: boolean });
  const reason = (body.reason ?? '').trim().slice(0, 200) || null;
  const ts = nowIso();

  // A ban on someone with no row still records one: they may have been invited
  // through an older path, or the operator may be pre-empting a return.
  await c.env.DB.prepare(
    `INSERT INTO organizers (email, added_at, added_by, banned_at, reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET banned_at = excluded.banned_at, reason = excluded.reason`,
  ).bind(email, ts, c.get('email'), ts, reason).run();

  let unpublished = 0;
  if (body.unpublish !== false) {
    const r = await c.env.DB.prepare(
      "UPDATE events SET status = 'draft' WHERE LOWER(owner_email) = ? AND status = 'ready'",
    ).bind(email).run();
    unpublished = r.meta.changes ?? 0;
  }

  return c.json({ banned: email, unpublished });
});

/** Let them back in. Their events stay unpublished until someone republishes. */
adminRoutes.delete('/organizers/:email/ban', async (c) => {
  requireOwner(c);
  const email = cleanEmail(c.req.param('email'));
  const r = await c.env.DB.prepare(
    'UPDATE organizers SET banned_at = NULL, reason = NULL WHERE email = ?',
  ).bind(email).run();
  if (!r.meta.changes) throw new HttpError(404, 'Not on the list', 'no_organizer');
  return c.json({ ok: true, email });
});

/**
 * Remove a row outright — for the address typed wrong, not for a person.
 *
 * Refused once they have published anything: deleting the row would take away
 * their access while leaving their events owned by an address on no list, which
 * is a ban with the record thrown away. Ban is the control for that, and it
 * says so.
 */
adminRoutes.delete('/organizers/:email', async (c) => {
  requireOwner(c);
  const email = cleanEmail(c.req.param('email'));
  if (email === operatorEmail(c)) {
    throw new HttpError(400, 'That is the operator account', 'bad_request');
  }

  const used = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM events WHERE LOWER(owner_email) = ?',
  ).bind(email).first<{ n: number }>();
  if ((used?.n ?? 0) > 0) {
    throw new HttpError(
      409,
      'They have events on the site. Remove access instead, which also unpublishes them.',
      'has_events',
    );
  }

  await c.env.DB.prepare('DELETE FROM organizers WHERE email = ?').bind(email).run();
  return c.json({ ok: true, email });
});

/**
 * The event, if it is this caller's to touch — the gate every scoped route runs
 * through.
 *
 * Being on the organizer list says a person may use the admin, not that they may
 * use it on somebody else's album. `events.owner_email` is what separates the
 * two, and the controls behind here include Remove, which deletes photos.
 *
 * 404 rather than 403 on a mismatch, deliberately: 403 would confirm that an
 * event with that id exists, and someone else's album is not a fact this caller
 * is entitled to. A missing event and a stranger's event look identical.
 *
 * NULL owner_email means the event predates ownership — the operator's, and
 * unreachable by anyone else, which is what those events already were.
 */
async function ownEvent(c: AdminCtx, eventId: string): Promise<EventRow> {
  const row = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?')
    .bind(eventId).first<EventRow>();
  if (!row) throw new HttpError(404, 'Event not found', 'no_event');
  if (c.get('owner')) return row;
  const email = (c.get('email') ?? '').toLowerCase();
  if (!email || (row.owner_email ?? '').toLowerCase() !== email) {
    throw new HttpError(404, 'Event not found', 'no_event');
  }
  return row;
}

/** Same gate, reached through whatever hangs off an event. */
async function ownVia(c: AdminCtx, sql: string, id: string, what: string): Promise<string> {
  const row = await c.env.DB.prepare(sql).bind(id).first<{ event_id: string }>();
  if (!row) throw new HttpError(404, `${what} not found`, 'not_found');
  await ownEvent(c, row.event_id);
  return row.event_id;
}

const ownSource = (c: AdminCtx, id: string) =>
  ownVia(c, 'SELECT event_id FROM sources WHERE id = ?', id, 'Link');
const ownPhoto = (c: AdminCtx, id: string) =>
  ownVia(c, 'SELECT event_id FROM photos WHERE id = ?', id, 'Photo');

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

/**
 * Start a thumbnail-vs-original comparison for a folder.
 *
 * On demand only. It costs a CI run, and the answer is per folder: a race shot
 * wider, or with runners further from the camera, may lose small faces at
 * 3200px where the 20 MB original would not.
 */
adminRoutes.post('/drive/benchmark', async (c) => {
  // Operator only: it spends a processing run to answer a question only the
  // operator's setting depends on.
  if (!c.get('owner')) throw new HttpError(403, 'Not available on this account', 'not_owner');
  const { url, sample } = await c.req.json<{ url?: string; sample?: number }>();
  if (!url) throw new HttpError(400, 'Missing url', 'bad_request');
  const folderId = parseFolderId(url);
  const id = newId();
  const n = Math.min(Math.max(Number(sample) || 6, 2), 12);

  await c.env.DB.prepare(
    `INSERT INTO benchmarks (id, folder_id, status, sample, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?, ?)`,
  ).bind(id, folderId, n, nowIso(), nowIso()).run();

  const res = await fetch(`https://api.github.com/repos/${c.env.GH_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'race-lens-worker', 'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'benchmark-folder',
      client_payload: { benchmark_id: id, folder_id: folderId, sample: n },
    }),
  });
  if (!res.ok) {
    await c.env.DB.prepare("UPDATE benchmarks SET status='failed', error=? WHERE id=?")
      .bind(`could not start (${res.status})`, id).run();
    throw new HttpError(502, `Could not start the comparison (${res.status})`, 'dispatch_failed');
  }
  return c.json({ benchmark_id: id, folder_id: folderId, sample: n }, 202);
});

adminRoutes.get('/benchmarks/:id', async (c) => {
  // Only the operator starts one, so only the operator reads one back.
  if (!c.get('owner')) throw new HttpError(403, 'Not available on this account', 'not_owner');
  const row = await c.env.DB.prepare('SELECT * FROM benchmarks WHERE id = ?')
    .bind(c.req.param('id')).first<any>();
  if (!row) throw new HttpError(404, 'Benchmark not found', 'no_benchmark');
  return c.json({
    benchmark: { ...row, result: row.result ? JSON.parse(row.result) : null },
  });
});

adminRoutes.get('/events', async (c) => {
  // A photographer's list is their own events and nothing else. The operator's
  // is everything, including the ones with no owner recorded.
  const email = (c.get('email') ?? '').toLowerCase();
  const { results } = c.get('owner')
    ? await c.env.DB.prepare('SELECT * FROM events ORDER BY created_at DESC').all<EventRow>()
    : await c.env.DB.prepare(
      'SELECT * FROM events WHERE LOWER(owner_email) = ? ORDER BY created_at DESC',
    ).bind(email).all<EventRow>();
  // owner_email is admin-only and deliberately not part of publicEvent: the
  // operator's list groups by it, and a photographer's list is their own events,
  // where it would only repeat their own address back at them.
  return c.json({
    events: results.map((e) => ({
      ...publicEvent(c.env, e),
      created_at: e.created_at,
      owner_email: c.get('owner') ? e.owner_email : null,
    })),
  });
});

adminRoutes.post('/events', async (c) => {
  const body = await c.req.json<{
    name?: string; event_date?: string; slug?: string; bibs_enabled?: boolean;
  }>();
  const name = (body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'name is required', 'bad_request');

  const slug = slugify(body.slug || name);
  if (!slug) throw new HttpError(400, 'Could not derive a slug from that name', 'bad_slug');

  const existing = await c.env.DB.prepare('SELECT id FROM events WHERE slug = ?').bind(slug).first();
  if (existing) throw new HttpError(409, `Slug "${slug}" is already taken`, 'dup_slug');

  const id = newId();
  // Absent means bibs are expected — the overwhelmingly common case, and the
  // behaviour every event had before this flag existed.
  // Ownership is recorded here and nowhere else. No route reassigns it: an owner
  // the API can change is not an owner.
  await c.env.DB.prepare(
    `INSERT INTO events (id, slug, name, event_date, status, bibs_enabled, owner_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, slug, name, body.event_date ?? null, 'draft',
         body.bibs_enabled === false ? 0 : 1, c.get('email'), nowIso()).run();

  const row = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
  return c.json({ event: publicEvent(c.env, row!) }, 201);
});

adminRoutes.patch('/events/:id', async (c) => {
  const id = c.req.param('id');
  await ownEvent(c, id);
  const body = await c.req.json<{
    name?: string; event_date?: string; status?: string; bibs_enabled?: boolean;
    bib_min_digits?: number; bib_max_digits?: number; bib_prefixes?: string;
    bib_prefix_required?: boolean;
  }>();
  const allowed = ['draft', 'indexing', 'ready', 'partial'];
  if (body.status && !allowed.includes(body.status)) {
    throw new HttpError(400, 'Invalid status', 'bad_status');
  }
  // Validated here rather than clamped, unlike the indexer's own guard: a value
  // out of range from this route is an operator mistake worth reporting, whereas
  // the indexer is defending against whatever reaches it and must never stop a
  // pass over it. 1 is deliberately excluded — a single digit is a partial read
  // of almost anything, and no race here prints one.
  if (body.bib_min_digits !== undefined
      && !(Number.isInteger(body.bib_min_digits)
           && body.bib_min_digits >= 2 && body.bib_min_digits <= 5)) {
    throw new HttpError(
      400, 'Shortest bib must be a whole number from 2 to 5', 'bad_bib_min_digits');
  }
  // Stored canonically — 'f, m' becomes 'F,M' — so the indexer and this route
  // never disagree about what a prefix list says. An empty string clears it back
  // to digits only; a value with nothing usable in it is a typo worth reporting
  // rather than silently storing as "no prefixes".
  if (body.bib_max_digits !== undefined
      && !(Number.isInteger(body.bib_max_digits)
           && body.bib_max_digits >= 2 && body.bib_max_digits <= 5)) {
    throw new HttpError(
      400, 'Longest bib must be a whole number from 2 to 5', 'bad_bib_max_digits');
  }
  // Checked against the OTHER bound as it will be after this write, not as it is
  // now: sending only one of the pair must not be able to leave the event with a
  // floor above its ceiling, which compiles to a pattern matching no bib at all.
  const existing = await c.env.DB
    .prepare('SELECT bib_min_digits, bib_max_digits FROM events WHERE id = ?')
    .bind(id).first<{ bib_min_digits: number; bib_max_digits: number }>();
  const nextMin = body.bib_min_digits ?? existing?.bib_min_digits ?? 3;
  const nextMax = body.bib_max_digits ?? existing?.bib_max_digits ?? 5;
  if (nextMin > nextMax) {
    throw new HttpError(
      400,
      `Shortest bib (${nextMin}) cannot be longer than the longest (${nextMax})`,
      'bad_bib_range');
  }

  let prefixes: string | null = null;
  if (body.bib_prefixes !== undefined) {
    const parsed = parsePrefixes(body.bib_prefixes);
    if (!parsed.length && body.bib_prefixes.trim() !== '') {
      throw new HttpError(
        400, 'Bib prefixes must be single letters or pairs, like F, M', 'bad_bib_prefixes');
    }
    prefixes = parsed.join(',');
  }

  // "Every bib has a letter" needs letters to require. Checked against the state
  // AFTER this write, like the digit range above, so setting both in one request
  // works and setting only one cannot leave the pair contradictory.
  //
  // The indexer ignores the flag without a prefix list rather than reading no
  // bibs at all — but an operator who ticks it on an event with no letters has
  // made a mistake worth reporting, not silently absorbing.
  // Clearing the letters clears the flag with them. Leaving it set would store a
  // contradiction — "every bib has a letter" at a race with no letters listed —
  // which the indexer ignores but which springs back to life the moment letters
  // are added again, changing behaviour nobody asked to change.
  let prefixRequired: number | null =
    body.bib_prefix_required === undefined ? null : (body.bib_prefix_required ? 1 : 0);
  if (body.bib_prefixes !== undefined && !parsePrefixes(prefixes).length) {
    prefixRequired = 0;
  }

  if (body.bib_prefix_required === true) {
    const listAfter = body.bib_prefixes !== undefined
      ? prefixes
      : (await c.env.DB.prepare('SELECT bib_prefixes FROM events WHERE id = ?')
          .bind(id).first<{ bib_prefixes: string | null }>())?.bib_prefixes ?? '';
    if (!parsePrefixes(listAfter).length) {
      throw new HttpError(
        400,
        'List the category letters first — "every bib has a letter" needs to know which letters',
        'bad_bib_prefix_required');
    }
  }
  // Turning bibs off leaves any bibs already read in place rather than deleting
  // them: the flag hides them and stops future passes reading more, so flipping
  // it back on restores what was there instead of forcing a re-index.
  await c.env.DB.prepare(
    // Numbered throughout, not anonymous: bib_prefixes needs its value TWICE
    // (once as the "was it sent" flag, once as the value), and mixing ?N with a
    // bare ? renumbers the lot.
    `UPDATE events SET name = COALESCE(?1, name),
                       event_date = COALESCE(?2, event_date),
                       status = COALESCE(?3, status),
                       bibs_enabled = COALESCE(?4, bibs_enabled),
                       bib_min_digits = COALESCE(?5, bib_min_digits),
                       bib_max_digits = COALESCE(?9, bib_max_digits),
                       bib_prefix_required = COALESCE(?10, bib_prefix_required),
                       -- Not COALESCE: '' must be able to CLEAR the list back to
                       -- digits only, and COALESCE reads only NULL as "leave it".
                       -- Same presence-not-value trick as jobs.error in
                       -- internal.ts.
                       bib_prefixes = CASE WHEN ?6 = 1 THEN ?7 ELSE bib_prefixes END
      WHERE id = ?8`,
  ).bind(body.name ?? null, body.event_date ?? null, body.status ?? null,
         body.bibs_enabled === undefined ? null : (body.bibs_enabled ? 1 : 0),
         body.bib_min_digits ?? null,
         body.bib_prefixes === undefined ? 0 : 1, prefixes, id,
         body.bib_max_digits ?? null,
         prefixRequired).run();
  const row = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
  if (!row) throw new HttpError(404, 'Event not found', 'no_event');
  // Neither bib setting is in publicEvent — runners have no use for them — so the
  // admin shapes carry them explicitly. Returned here as well as from GET so the
  // page reflects a save without re-fetching.
  return c.json({ event: {
    ...publicEvent(c.env, row),
    bib_min_digits: row.bib_min_digits,
    bib_max_digits: row.bib_max_digits,
    bib_prefixes: row.bib_prefixes ?? '',
    bib_prefix_required: (row.bib_prefix_required ?? 0) === 1,
  } });
});

const BANNER_MAX_BYTES = 8 * 1024 * 1024;

adminRoutes.post('/events/:id/banner', async (c) => {
  const id = c.req.param('id');
  await ownEvent(c, id);
  const form = await c.req.formData();
  const file = form.get('file') as unknown as File | string | null;
  // `instanceof File` does not narrow under @cloudflare/workers-types, so duck-type.
  if (!file || typeof file === 'string' || typeof file.stream !== 'function') {
    throw new HttpError(400, 'Expected multipart field "file"', 'bad_request');
  }
  // An allowlist, not a prefix test, and OUR content type rather than the
  // client's — see bannerType for what a prefix test let through.
  const type = bannerType(file.type);
  if (!type) {
    throw new HttpError(400, 'Banner must be a WebP, JPEG, PNG or AVIF image', 'bad_type');
  }
  // Checked before buffering, so an oversized upload is refused without reading
  // it into the isolate.
  if (file.size > BANNER_MAX_BYTES) {
    throw new HttpError(413, 'Banner must be under 8 MB', 'too_large');
  }

  // Without this the endpoint is a general write into the public bucket for any id
  // at all, and it would leave banner_key set on nothing.
  //
  // banner_key comes back too: the object it names is the one this upload
  // replaces, and after a successful write nothing else refers to it.
  const target = await c.env.DB.prepare('SELECT id, banner_key FROM events WHERE id = ?')
    .bind(id).first<{ id: string; banner_key: string | null }>();
  if (!target) throw new HttpError(404, 'Event not found', 'no_event');

  // Buffered rather than streamed, because the key is derived from the bytes and
  // a hash cannot be computed from a stream that has already been consumed. Bounded
  // by the size check above; the 8 MB ceiling is what makes this safe in a 128 MB
  // isolate.
  const bytes = await file.arrayBuffer();
  // `file.size` is the multipart parser's number and the check above trusted it.
  // This is the byte count we actually hold, so it is the one that decides.
  if (bytes.byteLength > BANNER_MAX_BYTES) {
    throw new HttpError(413, 'Banner must be under 8 MB', 'too_large');
  }
  if (bytes.byteLength === 0) throw new HttpError(400, 'Banner file is empty', 'bad_request');

  const key = await bannerKey(id, bytes, type.ext);
  await c.env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: type.contentType, cacheControl: 'public, max-age=31536000, immutable' },
  });
  await c.env.DB.prepare('UPDATE events SET banner_key = ? WHERE id = ?').bind(key, id).run();

  // Ordered write, then point, then delete. The object exists before any row names
  // it, and the old object outlives the row that named it, so neither a failure
  // between the steps nor a concurrent read can observe a banner_key with nothing
  // behind it.
  //
  // Re-uploading identical bytes yields the same key, and deleting it here would
  // delete what was just written — hence the comparison rather than an
  // unconditional delete of the previous value.
  if (target.banner_key && target.banner_key !== key) {
    // A failed cleanup leaves an unreferenced object, which costs storage and
    // nothing else. Not worth failing an upload that already succeeded over.
    c.executionCtx.waitUntil(
      c.env.BUCKET.delete(target.banner_key).catch(() => {}),
    );
  }
  return c.json({ banner_url: r2Url(c.env, key) });
});

/** Bind a Drive folder to an event and fire the CI indexing job. */
adminRoutes.post('/ingest', async (c) => {
  const { event_id, drive_url, image_source } = await c.req.json<{
    event_id?: string; drive_url?: string; image_source?: string;
  }>();
  if (!event_id || !drive_url) throw new HttpError(400, 'event_id and drive_url are required', 'bad_request');

  // Also the ownership gate: a link can only be added to your own event.
  const event = await ownEvent(c, event_id);

  const folderId = parseFolderId(drive_url);
  const ts = nowIso();

  // Re-use the source when this folder is already bound to this event.
  //
  // Every ingest used to insert a new row, so pasting the same link twice — or
  // re-running after a rate limit — produced duplicate sources for one folder.
  // The admin page then listed the same link several times, most with zero
  // photos, and any per-source total became nonsense.
  const existing = await c.env.DB.prepare(
    'SELECT id, image_source, removed_at FROM sources WHERE event_id = ? AND drive_folder_id = ?',
  ).bind(event_id, folderId).first<{ id: string; image_source: string; removed_at: string | null }>();

  // A withdrawn folder is not re-indexed by pasting its link again.
  //
  // The upsert below would otherwise happily revive it, and the event page
  // promises the photographer the opposite. Undoing a removal is a deliberate,
  // separate act — POST /sources/:id/restore — so it can never happen by reflex.
  if (existing?.removed_at) {
    throw new HttpError(
      409,
      'That link was removed at the photographer’s request. Restore it from the Drive links list first.',
      'source_removed',
    );
  }

  // An omitted image_source means "leave it alone", not "reset to original".
  //
  // The upsert below overwrites image_source unconditionally, and the Add-link
  // form on the event page posts no image_source at all — so re-adding a link
  // silently threw away a 'thumb' setting the organizer had chosen from the row
  // toggle, sending the next pass back to full-size downloads and the quota wall
  // that made them change it in the first place.
  //
  // A photographer never picks: resized, always. Originals are ~20 MB each and
  // Drive's limit is counted in bytes, so an album indexed at full size crawls
  // for days and needs someone watching it. Resized finds the same faces and
  // bibs. This is enforced here rather than by hiding the control, because the
  // control is not the only way to reach this route.
  const imgSrc = !c.get('owner')
    ? 'thumb'
    : image_source === 'thumb' || image_source === 'original'
      ? image_source
      : existing?.image_source ?? 'original';

  const sourceId = existing?.id ?? newId();
  const jobId = newId();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO sources (id, event_id, drive_folder_id, drive_url, added_at, image_source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id, drive_folder_id) DO UPDATE SET
         drive_url = excluded.drive_url, image_source = excluded.image_source`,
    ).bind(sourceId, event_id, folderId, drive_url, ts, imgSrc),
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
      client_payload: {
        event_id, source_id: sourceId, folder_id: folderId, job_id: jobId,
        image_source: imgSrc,
      },
    }),
  });

  if (!res.ok) {
    // The upstream body goes to the Worker log, not into the job row: job.error
    // is rendered on a page photographers now reach, and that body names the
    // repository and the API behind it.
    console.error('index dispatch failed', res.status, (await res.text()).slice(0, 300));
    // Mark the job failed immediately rather than leaving the admin UI
    // polling a job that no runner will ever pick up.
    await c.env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
    ).bind(`could not start indexing (${res.status})`, nowIso(), jobId).run();
    throw new HttpError(502, `Could not start indexing (${res.status}). Try again in a minute.`, 'dispatch_failed');
  }

  return c.json({ job_id: jobId, source_id: sourceId, folder_id: folderId }, 202);
});

/**
 * Everything the organizer needs to answer "why is my album short?" without
 * access to CI logs: every link bound to the event, what each one found versus
 * what actually landed, and the reason for each miss.
 */
/**
 * Dispatch one indexing pass. Returns null on success, or the upstream status.
 *
 * Extracted because this same fetch was written out verbatim at every site that
 * starts a pass, and the payload has a history of drifting between them: omitting
 * image_source silently downgraded continuations of a 'thumb' source back to
 * full-size downloads, straight into the quota that had ended the previous pass.
 * One place to add a key means one place to get it wrong.
 */
async function dispatchIndex(
  c: AdminCtx, payload: Record<string, unknown>,
): Promise<number | null> {
  const res = await fetch(`https://api.github.com/repos/${c.env.GH_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'race-lens-worker', 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'index-event', client_payload: payload }),
  });
  if (res.ok) return null;
  // Body to the log, not to the caller: it names the repository and the API.
  console.error('index dispatch failed', res.status, (await res.text()).slice(0, 300));
  return res.status;
}

/**
 * Re-read bib numbers for an album that is already indexed.
 *
 * The gap this closes: changing a bib rule only affects what LATER passes read,
 * and Recheck cannot be that pass — it skips every photo with faces_done, which
 * on a finished album is all of them. So an organizer who set "bibs here are two
 * digits" pressed Recheck, was correctly told every photo was already indexed,
 * and got no bibs. The only thing that re-reads is --bibs-only, which until now
 * had no UI at all and had to be dispatched by hand.
 *
 * One pass per live Drive link. They queue rather than run together — the
 * workflow's concurrency group is per event — so this is safe to fire for a
 * multi-link album.
 *
 * NOT cheap, and the UI says so: --bibs-only forces no_resume, so every photo is
 * downloaded again, and it deliberately does not chain a continuation, so a quota
 * stop needs one press of Continue. It leaves faces, thumbnails and the vector
 * index untouched.
 */
adminRoutes.post('/events/:id/bibs/reread', async (c) => {
  const eventId = c.req.param('id');
  const event = await ownEvent(c, eventId);

  // A bibs-only pass over an event with no bibs downloads every photo to write
  // nothing. The runner refuses it too; better to say so before the download.
  if (event.bibs_enabled === 0) {
    throw new HttpError(
      400, 'This event is marked as having no bib numbers, so there is nothing to re-read',
      'no_bibs');
  }

  // Refuse while a pass is already moving. Two passes over one event would race
  // on the same photos' bib rows, and the workflow queues rather than cancels, so
  // the second would sit behind the first anyway. Stale jobs do not count — same
  // 20-minute rule the report uses, or a runner GitHub reclaimed would block this
  // forever.
  const STALE_MS = 20 * 60 * 1000;
  const { results: live } = await c.env.DB.prepare(
    `SELECT id, updated_at FROM jobs
      WHERE event_id = ? AND status IN ('queued', 'running')`,
  ).bind(eventId).all<{ id: string; updated_at: string }>();
  if (live.some((j) => Date.now() - Date.parse(j.updated_at) < STALE_MS)) {
    throw new HttpError(
      409, 'A pass is already running on this album. Wait for it to finish, or stop it first.',
      'job_active');
  }

  const { results: sources } = await c.env.DB.prepare(
    `SELECT id, drive_folder_id, image_source,
            (SELECT COUNT(*) FROM photos p WHERE p.source_id = s.id) AS photos
       FROM sources s WHERE s.event_id = ? AND s.removed_at IS NULL`,
  ).bind(eventId).all<{ id: string; drive_folder_id: string; image_source: string | null;
                        photos: number }>();
  if (!sources.length) {
    throw new HttpError(400, 'This event has no Drive links to re-read', 'no_sources');
  }

  const started: { job_id: string; source_id: string; photos: number; rounds: number }[] = [];
  const failed: { source_id: string; status: number }[] = [];
  for (const src of sources) {
    const jobId = newId();
    await c.env.DB.prepare(
      'INSERT INTO jobs (id, event_id, source_id, status, total, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(jobId, eventId, src.id, 'queued', src.photos, nowIso()).run();
    const status = await dispatchIndex(c, {
      event_id: eventId, source_id: src.id, folder_id: src.drive_folder_id,
      job_id: jobId,
      // Carried explicitly: the workflow defaults to 'original' when absent, which
      // would turn a ~2-round pass into ~27.
      image_source: src.image_source ?? 'original',
      bibs_only: true,
    });
    if (status !== null) {
      await c.env.DB.prepare("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?")
        .bind(`could not start the bib re-read (${status})`, nowIso(), jobId).run();
      failed.push({ source_id: src.id, status });
      continue;
    }
    // Same per-round rates the event page quotes for a link's remaining work.
    const perRound = (src.image_source ?? 'original') === 'thumb' ? 600 : 25;
    started.push({ job_id: jobId, source_id: src.id, photos: src.photos,
                   rounds: Math.max(1, Math.ceil(src.photos / perRound)) });
  }

  // Partial failure is reported rather than thrown: passes that DID start are
  // running, and a 502 here would read as "nothing happened".
  if (!started.length) {
    throw new HttpError(
      502, `Could not start the bib re-read (${failed[0]?.status}). Try again in a minute.`,
      'dispatch_failed');
  }
  return c.json({ started, failed }, 202);
});

adminRoutes.get('/events/:id/report', async (c) => {
  await ownEvent(c, c.req.param('id'));
  const eventId = c.req.param('id');

  const { results: sources } = await c.env.DB.prepare(
    `SELECT s.id, s.drive_folder_id, s.drive_url, s.discovered, s.added_at, s.image_source,
            s.credit_name, s.removed_at,
            (SELECT COUNT(*) FROM photos p WHERE p.source_id = s.id) AS indexed
       FROM sources s WHERE s.event_id = ? ORDER BY s.added_at`,
  ).bind(eventId).all<any>();

  // Bounded, and reported alongside the true total.
  //
  // This was unbounded, which was fine while an event had a handful of passes.
  // A rate-limited folder produces one job per continuation — a 31k-photo album
  // can run to hundreds — and every one of them was serialized into this
  // response on every 6-second poll.
  const JOBS_LIMIT = 100;
  const LOG_LIMIT = 300;

  const { results: rawJobs } = await c.env.DB.prepare(
    `SELECT id, source_id, status, done, total, skipped, attempts, error,
            stop_requested, updated_at
       FROM jobs WHERE event_id = ? ORDER BY updated_at DESC LIMIT ?`,
  ).bind(eventId, JOBS_LIMIT).all<any>();

  const totals = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM jobs WHERE event_id = ?1) AS jobs,
            (SELECT COUNT(*) FROM ingest_log WHERE event_id = ?1) AS log`,
  ).bind(eventId).first<{ jobs: number; log: number }>();

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
       FROM ingest_log WHERE event_id = ? ORDER BY id DESC LIMIT ?`,
  ).bind(eventId, LOG_LIMIT).all<any>();

  // Bounded like the two lists above it. There are only a handful of (level, code)
  // pairs in practice, so this is a ceiling rather than a truncation anyone will
  // notice — but it was the one aggregate in this handler with no upper bound at
  // all, on a response the event page polls for the length of an indexing run.
  const { results: counts } = await c.env.DB.prepare(
    `SELECT level, code, COUNT(*) AS n FROM ingest_log
      WHERE event_id = ? GROUP BY level, code ORDER BY n DESC LIMIT 40`,
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
    //
    // A withdrawn link is never short either: its photos are being deleted on
    // purpose, so counting the gap against `discovered` would report thousands of
    // "missing" photos and an event stuck at 'partial' for doing exactly what was
    // asked. It is listed, with its removal shown, and left out of the arithmetic.
    discovered_known: !s.removed_at && (s.discovered ?? 0) > 0,
    missing: !s.removed_at && (s.discovered ?? 0) > 0
      ? Math.max(0, s.discovered - (s.indexed ?? 0))
      : 0,
  }));

  // Withdrawn links stay in `sources` — the organizer needs to see that a link was
  // removed and by when — but every total is about the album that still exists.
  const liveSources = withMissing.filter((s) => !s.removed_at);

  return c.json({
    sources: withMissing,
    totals: {
      links: liveSources.length,
      removed_links: withMissing.length - liveSources.length,
      found: liveSources.reduce((n, s) => n + (s.discovered_known ? s.discovered : 0), 0),
      found_known: liveSources.every((s) => s.discovered_known),
      indexed: live?.n ?? 0,
      missing: liveSources.reduce((n, s) => n + s.missing, 0),
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
    // The client pages through what it was sent; these say how much exists, so
    // "showing 100 of 412" can be honest about the tail it will never render.
    jobs_total: totals?.jobs ?? jobs.length,
    jobs_returned: jobs.length,
    log_total: totals?.log ?? log.length,
    log_returned: log.length,
  });
});

/** Re-run one source: a fresh job over the same folder. Resume skips what exists. */
/**
 * Switch a link between full originals and Drive's resized copies.
 *
 * This was only settable when the link was first added, which is exactly the
 * wrong time: nobody knows a folder is too big to download until they watch it
 * stall. A 31k-photo folder on originals moves ~25 photos per Drive quota
 * window; the same folder on thumbnails moves ~12x that, for the same faces and
 * bibs. Being unable to change it after the fact made the discovery useless.
 *
 * Photos already indexed are NOT re-fetched — the setting applies to whatever
 * is still missing, so switching costs nothing already spent.
 *
 * Also where the photographer's byline is set. Both fields are optional and applied
 * independently: the image-size toggle and the credit box are two controls on the
 * same row, and sending one must not blank the other.
 */
adminRoutes.patch('/sources/:id', async (c) => {
  const sourceId = c.req.param('id');
  await ownSource(c, sourceId);
  const body = await c.req.json<{ image_source?: string; credit_name?: string | null }>()
    .catch(() => ({}) as any);

  const sets: string[] = [];
  const binds: (string | null)[] = [];

  if (body.image_source !== undefined) {
    if (body.image_source !== 'thumb' && body.image_source !== 'original') {
      throw new HttpError(400, "image_source must be 'thumb' or 'original'", 'bad_image_source');
    }
    // Same rule as /ingest: only the operator chooses full originals.
    if (body.image_source === 'original' && !c.get('owner')) {
      throw new HttpError(403, 'Albums are indexed from resized copies', 'not_owner');
    }
    sets.push('image_source = ?');
    binds.push(body.image_source);
  }

  if (body.credit_name !== undefined) {
    // An empty box means "no name recorded", which is a real state the event page
    // renders (album link alone) — so it is stored as NULL rather than as ''.
    const name = String(body.credit_name ?? '').trim();
    if (name.length > 80) throw new HttpError(400, 'A credit is at most 80 characters', 'bad_credit');
    sets.push('credit_name = ?');
    binds.push(name || null);
  }

  if (!sets.length) {
    throw new HttpError(400, 'Nothing to update — send image_source or credit_name', 'bad_request');
  }

  const r = await c.env.DB.prepare(
    `UPDATE sources SET ${sets.join(', ')} WHERE id = ?`,
  ).bind(...binds, sourceId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Link not found', 'no_source');
  return c.json({ ok: true });
});

/**
 * How many photos one purge round deletes, and how many rounds run per request.
 *
 * A round is a SELECT, a handful of chunked DELETE batches, and one R2 bulk
 * delete; four of them fit comfortably inside a request while staying far below
 * the subrequest ceiling. An 8,500-photo album is therefore two or three calls,
 * which the admin page makes in a loop — the alternative is a single request that
 * times out on exactly the albums where removal matters most.
 */
const PURGE_BATCH = 500;
const PURGE_ROUNDS = 4;

/**
 * Take a photographer's link off the site, at their request.
 *
 * They message @chethavuthy on Telegram; this is what answers them. Removal is per
 * LINK, which is the unit the photographer owns: the source is marked withdrawn —
 * which hides it from every public query immediately, see NOT_REMOVED in public.ts —
 * and then its photos, thumbnails, faces and bibs are deleted in batches.
 *
 * The source ROW survives, holding removed_at. It has to: POST /ingest upserts on
 * (event_id, drive_folder_id), so this row is the only memory that the folder was
 * withdrawn, and without it the next paste of the link re-indexes the album.
 *
 * Face VECTORS stay in their R2 shards. A shard is an immutable byte range that
 * every later row_idx is defined against, so rewriting one to excise rows would
 * renumber the whole event's index. With no faces row pointing at them they cannot
 * be joined back to a photo by any query — unreachable, not merely hidden.
 */
adminRoutes.delete('/sources/:id', async (c) => {
  const sourceId = c.req.param('id');
  await ownSource(c, sourceId);
  const src = await c.env.DB.prepare(
    'SELECT id, event_id, removed_at FROM sources WHERE id = ?',
  ).bind(sourceId).first<{ id: string; event_id: string; removed_at: string | null }>();
  if (!src) throw new HttpError(404, 'Link not found', 'no_source');

  // Idempotent: the admin page calls this repeatedly to finish a long purge, and
  // only the first call sets the timestamp.
  if (!src.removed_at) {
    await c.env.DB.prepare('UPDATE sources SET removed_at = ? WHERE id = ?')
      .bind(nowIso(), sourceId).run();
  }

  let purged = 0;
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const { results: batch } = await c.env.DB.prepare(
      'SELECT id, thumb_key FROM photos WHERE source_id = ? LIMIT ?',
    ).bind(sourceId, PURGE_BATCH).all<{ id: string; thumb_key: string | null }>();
    if (!batch.length) break;

    const ids = batch.map((p) => p.id);
    for (const part of chunk(ids, 90)) {
      const marks = part.map(() => '?').join(',');
      // Order matters: the child rows reference photos(id), so photos goes last.
      await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM faces WHERE photo_id IN (${marks})`).bind(...part),
        c.env.DB.prepare(`DELETE FROM bibs WHERE photo_id IN (${marks})`).bind(...part),
        c.env.DB.prepare(`DELETE FROM bib_rejects WHERE photo_id IN (${marks})`).bind(...part),
        c.env.DB.prepare(`DELETE FROM photos WHERE id IN (${marks})`).bind(...part),
      ]);
    }

    // The thumbnails are the copies Race Lens itself published, so they go too —
    // leaving them would keep the photographer's work served from our bucket after
    // they asked for it to stop.
    const keys = batch.map((p) => p.thumb_key).filter((k): k is string => !!k);
    if (keys.length) await c.env.BUCKET.delete(keys);

    purged += batch.length;
  }

  const left = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM photos WHERE source_id = ?',
  ).bind(sourceId).first<{ n: number }>();

  // Recount every call, not only on the last one: the event page shows this number
  // beside its title, and mid-purge it should read the truth rather than a total
  // that includes photos already gone.
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM photos WHERE event_id = ?1) AS photos,
            (SELECT COUNT(*) FROM faces  WHERE event_id = ?1) AS faces`,
  ).bind(src.event_id).first<{ photos: number; faces: number }>();
  await c.env.DB.prepare('UPDATE events SET photo_count = ?, face_count = ? WHERE id = ?')
    .bind(counts?.photos ?? 0, counts?.faces ?? 0, src.event_id).run();

  return c.json({ ok: true, purged, remaining: left?.n ?? 0 });
});

/**
 * Undo a removal — for the case where it was done to the wrong link.
 *
 * This does NOT bring the photos back; they were deleted. It clears the flag so
 * the link can be re-indexed, and the caller still has to press Re-index. Two
 * deliberate steps, because a photographer's withdrawal should not be reversible
 * by one stray click.
 */
adminRoutes.post('/sources/:id/restore', async (c) => {
  const sourceId = c.req.param('id');
  await ownSource(c, sourceId);
  const r = await c.env.DB.prepare(
    'UPDATE sources SET removed_at = NULL WHERE id = ?',
  ).bind(sourceId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Link not found', 'no_source');
  return c.json({ ok: true });
});

adminRoutes.post('/sources/:id/reindex', async (c) => {
  const sourceId = c.req.param('id');
  await ownSource(c, sourceId);
  const src = await c.env.DB.prepare('SELECT * FROM sources WHERE id = ?').bind(sourceId).first<any>();
  if (!src) throw new HttpError(404, 'Source not found', 'no_source');

  const jobId = newId();
  await c.env.DB.prepare(
    'INSERT INTO jobs (id, event_id, source_id, status, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(jobId, src.event_id, sourceId, 'queued', nowIso()).run();

  const status = await dispatchIndex(c, {
    event_id: src.event_id, source_id: sourceId,
    folder_id: src.drive_folder_id, job_id: jobId,
    image_source: src.image_source ?? 'original',
  });
  if (status !== null) {
    await c.env.DB.prepare("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?")
      .bind(`could not start indexing (${status})`, nowIso(), jobId).run();
    throw new HttpError(502, `Could not start indexing (${status}). Try again in a minute.`, 'dispatch_failed');
  }
  return c.json({ job_id: jobId }, 202);
});

adminRoutes.get('/events/:id', async (c) => {
  const row = await ownEvent(c, c.req.param('id'));
  return c.json({ event: {
    ...publicEvent(c.env, row),
    created_at: row.created_at,
    bib_min_digits: row.bib_min_digits,
    bib_max_digits: row.bib_max_digits,
    bib_prefixes: row.bib_prefixes ?? '',
    bib_prefix_required: (row.bib_prefix_required ?? 0) === 1,
  } });
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
  await ownEvent(c, eventId);
  const limit = clampLimit(c.req.query('limit'), 24, 60);
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
      `SELECT id, photo_id, bbox, bib FROM faces WHERE photo_id IN (${ph})`).bind(...part).all<any>();
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
      return {
        ...publicPhoto(c.env, p),
        // One conversion, shared with the public face search, tested in
        // test/bbox.test.ts. The inline `x / (p.width || 1)` this replaces was the
        // second of two places that had to agree about the pixel space, and the
        // only reason the 2026-08-09 mismatch was ever visible to a human.
        faces: (fMap[p.id] ?? []).flatMap((f: any) => {
          const box = faceBox(JSON.parse(f.bbox), p.width, p.height);
          return box ? [{ id: f.id, bib: f.bib, ...box }] : [];
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
/**
 * Reject a hand-typed bare number where every bib carries a letter.
 *
 * The OCR path already refuses these, so accepting one here would let the manual
 * control write a bib the pipeline considers impossible — and at such a race a
 * bare number is not a different runner, it is a missing letter. Worth saying so
 * rather than storing something no search will ever be right about.
 *
 * Silent when the event lists no letters, matching the indexer: the flag alone
 * must never be the reason an entry is refused.
 */
async function requirePrefixIfEventDoes(
  c: AdminCtx, eventId: string, normalized: string, typed: string,
): Promise<void> {
  if (normalized.includes(PREFIX_SEP)) return;
  const ev = await c.env.DB
    .prepare('SELECT bib_prefixes, bib_prefix_required FROM events WHERE id = ?')
    .bind(eventId).first<{ bib_prefixes: string | null; bib_prefix_required: number }>();
  const letters = parsePrefixes(ev?.bib_prefixes);
  if ((ev?.bib_prefix_required ?? 0) === 1 && letters.length) {
    throw new HttpError(
      400,
      // Suggests what they TYPED with a letter in front, not the normalized form:
      // "try F-1" reads as a different number from the 0001 printed on the bib.
      `Every bib at this race starts with a letter — try ${letters[0]}-${typed || normalized}`,
      'bib_prefix_required');
  }
}

adminRoutes.post('/photos/:id/bibs', async (c) => {
  await ownPhoto(c, c.req.param('id'));
  const photoId = c.req.param('id');
  const { bib } = await c.req.json<{ bib?: string }>();

  // normalizeBib, so an operator correcting a bib can type the category letter
  // the OCR missed — the whole point of this control at a mixed race. A bare
  // digit strip turned "F-0001" into "1", silently filing a 10k woman's photo
  // under the marathon runner who owns that number.
  const raw = String(bib ?? '').trim();
  const norm = normalizeBib(raw);
  if (!norm) {
    throw new HttpError(
      400, 'Enter a bib like 0056, or F-0056 if this race uses category letters',
      'bad_bib');
  }

  const photo = await c.env.DB.prepare('SELECT event_id FROM photos WHERE id = ?')
    .bind(photoId).first<{ event_id: string }>();
  if (!photo) throw new HttpError(404, 'Photo not found', 'no_photo');
  await requirePrefixIfEventDoes(c, photo.event_id, norm, raw);

  await c.env.DB.prepare(
    `INSERT INTO bibs (event_id, bib, photo_id, conf, bib_raw, source)
     VALUES (?, ?, ?, 1.0, ?, 'manual')
     ON CONFLICT (event_id, bib, photo_id) DO UPDATE SET
       conf = 1.0, bib_raw = excluded.bib_raw, source = 'manual'`,
  ).bind(photo.event_id, norm, photoId, raw).run();

  return c.json({ ok: true, bib: norm, bib_raw: raw });
});

/**
 * Assign a bib to ONE face.
 *
 * Photo-level entry cannot say which runner a number belongs to, and in a
 * group shot that is most of the information. Writing faces.bib as well keeps
 * the face<->bib association the torso-crop pass produces automatically, so a
 * runner found by face can also be told their number.
 */
/** Re-run the pipeline on ONE photo. Seconds, rather than a whole-folder pass. */
adminRoutes.post('/photos/:id/reindex', async (c) => {
  const photoId = c.req.param('id');
  await ownPhoto(c, photoId);
  const photo = await c.env.DB.prepare(
    `SELECT p.drive_file_id, p.event_id, p.source_id, s.drive_folder_id, s.image_source
       FROM photos p JOIN sources s ON s.id = p.source_id WHERE p.id = ?`,
  ).bind(photoId).first<any>();
  if (!photo) throw new HttpError(404, 'Photo not found', 'no_photo');

  // Clear this photo's machine-derived rows so the re-read is authoritative.
  // Manual corrections survive: they are the one thing a re-run must not undo.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photoId),
    c.env.DB.prepare("DELETE FROM bibs WHERE photo_id = ? AND source = 'ocr'").bind(photoId),
  ]);

  const jobId = newId();
  await c.env.DB.prepare(
    'INSERT INTO jobs (id, event_id, source_id, status, total, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
  ).bind(jobId, photo.event_id, photo.source_id, 'queued', nowIso()).run();

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
        event_id: photo.event_id, source_id: photo.source_id,
        folder_id: photo.drive_folder_id, job_id: jobId,
        only_file: photo.drive_file_id,
        image_source: photo.image_source ?? 'original',
      },
    }),
  });
  if (!res.ok) throw new HttpError(502, `Could not start (${res.status})`, 'dispatch_failed');
  return c.json({ job_id: jobId }, 202);
});

adminRoutes.post('/faces/:id/bib', async (c) => {
  await ownVia(c, 'SELECT event_id FROM faces WHERE id = ?', c.req.param('id'), 'Face');
  const faceId = c.req.param('id');
  const { bib } = await c.req.json<{ bib?: string }>();
  // Same as the photo-level route: the letter is part of which runner this is.
  const raw = String(bib ?? '').trim();

  const face = await c.env.DB.prepare(
    'SELECT event_id, photo_id, bib FROM faces WHERE id = ?',
  ).bind(faceId).first<{ event_id: string; photo_id: string; bib: string | null }>();
  if (!face) throw new HttpError(404, 'Face not found', 'no_face');

  // Empty input clears the assignment rather than erroring — that is how you
  // undo a mistake without hunting for a separate control.
  if (!raw) {
    await c.env.DB.prepare('UPDATE faces SET bib = NULL WHERE id = ?').bind(faceId).run();
    return c.json({ ok: true, bib: null });
  }
  const norm = normalizeBib(raw);
  if (!norm) {
    throw new HttpError(
      400, 'Enter a bib like 0056, or F-0056 if this race uses category letters',
      'bad_bib');
  }
  await requirePrefixIfEventDoes(c, face.event_id, norm, raw);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE faces SET bib = ? WHERE id = ?').bind(norm, faceId),
    // Photo-level row too, since that is what bib search actually queries.
    c.env.DB.prepare(
      `INSERT INTO bibs (event_id, bib, photo_id, conf, bib_raw, source)
       VALUES (?, ?, ?, 1.0, ?, 'manual')
       ON CONFLICT (event_id, bib, photo_id) DO UPDATE SET
         conf = 1.0, bib_raw = excluded.bib_raw, source = 'manual'`,
    ).bind(face.event_id, norm, face.photo_id, raw),
    // A number assigned by hand is no longer rejected.
    c.env.DB.prepare(
      'DELETE FROM bib_rejects WHERE event_id = ? AND photo_id = ? AND bib = ?',
    ).bind(face.event_id, face.photo_id, norm),
  ]);

  return c.json({ ok: true, bib: norm, bib_raw: raw });
});

adminRoutes.delete('/photos/:id/bibs/:bib', async (c) => {
  const photoId = c.req.param('id');
  await ownPhoto(c, photoId);
  // Must normalize the same way the row was written, prefix included: stripping
  // the letter here would delete 'F-1' by tombstoning '1' — leaving the wrong bib
  // in place and rejecting a bib nobody asked to remove.
  const norm = normalizeBib(c.req.param('bib'));
  if (!norm) throw new HttpError(400, 'Not a bib number', 'bad_bib');
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
  // The admin page polls this every few seconds while an album indexes, so it is
  // the one route a stranger's id would most easily be tried against.
  await ownEvent(c, row.event_id);
  return c.json({ job: row });
});

/**
 * Stop a pass that is under way. Cooperative — see jobs.stop_requested.
 *
 * Sets the flag and lets the runner end itself at its next batch boundary,
 * having flushed. Two things make that safe to expose as a button:
 *
 *  * Stopping cannot lose work. Every batch writes its vectors, bibs and
 *    faces_done before the next one starts, so the most a stop discards is the
 *    downloads of the batch in flight — which the next pass simply redoes.
 *  * Stopping is pausing. faces_done is what the resume filter reads, so the
 *    ordinary Continue button picks the album up exactly where it stopped.
 *    There is deliberately no separate Resume: a second control for the same
 *    act would only invite the question of how they differ.
 *
 * A job that has not started yet is stopped outright here rather than waiting
 * for a runner to notice — it may have none. The dispatched workflow still runs,
 * finds the flag on its first progress ping and exits without downloading.
 */
adminRoutes.post('/jobs/:id/stop', async (c) => {
  const id = c.req.param('id');
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?')
    .bind(id).first<JobRow & { stop_requested: number }>();
  if (!job) throw new HttpError(404, 'Job not found', 'no_job');
  await ownEvent(c, job.event_id);

  // Anything already finished stays as it finished. Rewriting a 'done' pass to
  // 'stopped' would rewrite history for a run that had nothing left to stop.
  if (!['queued', 'running'].includes(job.status)) {
    return c.json({ stopped: false, status: job.status, reason: 'not_running' });
  }

  // 'queued' has no runner mid-batch to wait for, so it ends here. 'running'
  // keeps its status until the runner writes its own — the pass is genuinely
  // still going, and claiming otherwise would have the page report an idle
  // album while a runner is still downloading into it.
  const queued = job.status === 'queued';
  await c.env.DB.prepare(
    `UPDATE jobs SET stop_requested = 1,
                     status = CASE WHEN ?1 = 1 THEN 'stopped' ELSE status END,
                     error = ?2, updated_at = ?3
      WHERE id = ?4`,
  ).bind(
    queued ? 1 : 0,
    queued
      ? 'Stopped before it started. Press Continue to run it.'
      : 'Stopping after the batch in progress — press Continue to carry on later.',
    nowIso(), id,
  ).run();

  return c.json({ stopped: true, status: queued ? 'stopped' : 'stopping' });
});

adminRoutes.get('/events/:id/jobs', async (c) => {
  await ownEvent(c, c.req.param('id'));
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM jobs WHERE event_id = ? ORDER BY updated_at DESC LIMIT 20',
  ).bind(c.req.param('id')).all<JobRow>();
  return c.json({ jobs: results });
});
