#!/usr/bin/env node
/**
 * Worker smoke test: create an event, ingest photos, write faces and bibs, search.
 *
 * apps/api had no tests at all, and that is the gap the audit came out of. Four of
 * its findings were things a single run of this script would have caught in
 * seconds — including two that make a fresh database unable to index anything:
 *
 *   C1  bib_rejects was queried in three places and created by no schema file
 *   C2  sources had no UNIQUE (event_id, drive_folder_id), so the ingest upsert
 *       could not even be PREPARED
 *   C7  a retried /faces POST tripped the unique index and failed the whole run
 *   P4  ?limit=-1 became `LIMIT -1`, which SQLite treats as unbounded
 *
 * None of them are visible to `tsc`, and production hid all of them because its
 * DDL had been applied by hand and never committed.
 *
 * Assumes `wrangler dev` is already up against a LOCAL D1 that has had schema.sql
 * and every migration applied. See the "Worker smoke test" step in ci.yml.
 *
 *   node tools/smoke.mjs [--api=http://127.0.0.1:8787] [--secret=…]
 */
const args = process.argv.slice(2);
const arg = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;

const API = (arg('api', process.env.SMOKE_API ?? 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const SECRET = arg('secret', process.env.INGEST_SECRET ?? 'smoke-test-secret');
const EVENT_SLUG = `smoke-${Date.now().toString(36)}`;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m, detail) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
  if (detail !== undefined) console.log(`        ${detail}`);
};
const check = (cond, m, detail) => (cond ? ok(m) : bad(m, detail));

const ingest = (path, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': SECRET, ...(init.headers ?? {}) },
  });
const admin = (path, init = {}) => fetch(`${API}${path}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
});
const json = async (res) => { try { return await res.json(); } catch { return null; } };

const DIM = 512;
const oneHot = (i) => { const v = new Array(DIM).fill(0); v[i] = 1; return v; };

async function main() {
  console.log(`\nRace Lens Worker smoke test → ${API}\n`);

  // --- setup ---------------------------------------------------------------
  console.log('Setup');
  const evRes = await admin('/api/admin/events', {
    method: 'POST',
    body: JSON.stringify({ name: `Smoke ${EVENT_SLUG}`, slug: EVENT_SLUG, bibs_enabled: true }),
  });
  const ev = await json(evRes);
  if (evRes.status !== 201 || !ev?.event?.id) {
    bad(`create event → ${evRes.status}`, JSON.stringify(ev));
    console.log('\nCannot continue without an event. Is DEV_ADMIN_BYPASS=1 in apps/api/.dev.vars?');
    return 1;
  }
  const eventId = ev.event.id;
  ok(`created event ${eventId}`);

  // C2: the ingest upsert names ON CONFLICT (event_id, drive_folder_id), which
  // SQLite refuses to PREPARE without a matching unique index. The GitHub dispatch
  // that follows will fail here (no credentials, and that is fine) — what matters
  // is that it fails at the DISPATCH, not with an internal error from the SQL.
  const ing = await admin('/api/admin/ingest', {
    method: 'POST',
    body: JSON.stringify({ event_id: eventId, drive_url: 'https://drive.google.com/drive/folders/smokefolder1' }),
  });
  const ingBody = await json(ing);
  check(
    ing.status !== 500 && ingBody?.code !== 'internal',
    'C2  ingest upsert prepares (no unique index → 500 internal)',
    `status=${ing.status} code=${ingBody?.code}`,
  );

  // The source row is committed in the same batch as the job, BEFORE the dispatch
  // that fails here, so read it back from the report rather than from the error
  // body. That also exercises the report endpoint, which is the heaviest query in
  // the admin API and the one the event page polls.
  const report = await json(await admin(`/api/admin/events/${eventId}/report`));
  const sourceId = report?.sources?.[0]?.id;
  check(!!sourceId, 'report returns the source the ingest created',
        JSON.stringify(report?.sources));
  if (!sourceId) {
    console.log('\nCannot continue without a source.');
    return 1;
  }

  // --- ingest --------------------------------------------------------------
  console.log('\nIngest');
  const photos = [
    { drive_file_id: 'smokefile0001', thumb_key: `thumbs/${eventId}/a.webp`, width: 4000, height: 3000 },
    { drive_file_id: 'smokefile0002', thumb_key: `thumbs/${eventId}/b.webp`, width: 3000, height: 4000 },
  ];
  const put = await ingest(`/api/internal/events/${eventId}/photos`, {
    method: 'POST', body: JSON.stringify({ source_id: sourceId, photos }),
  });
  const putBody = await json(put);
  check(put.ok && Object.keys(putBody?.photo_ids ?? {}).length === 2,
        'photo upsert returns drive_file_id → photo_id', JSON.stringify(putBody));
  const photoIds = putBody.photo_ids;
  const p1 = photoIds.smokefile0001;

  // S4: this column reaches a shell as `--only-file`.
  const evil = await ingest(`/api/internal/events/${eventId}/photos`, {
    method: 'POST',
    body: JSON.stringify({ source_id: sourceId, photos: [{ drive_file_id: 'x"; touch /tmp/pwned; echo "', thumb_key: 'k' }] }),
  });
  check((await json(evil))?.code === 'bad_file_id', 'S4  drive_file_id rejects a shell payload', `status=${evil.status}`);

  // C4: a photo is not "indexed" until its vectors are durable.
  const idx0 = await json(await ingest(`/api/internal/events/${eventId}/indexed`));
  check(idx0?.drive_file_ids?.length === 0,
        'C4  freshly ingested photos are NOT yet resumable', JSON.stringify(idx0));

  // --- faces ---------------------------------------------------------------
  console.log('\nFaces and search');
  const shardKey = `index/${eventId}/smoke-1.bin`;
  const rows = new Uint8Array(2 * DIM);
  rows[0 * DIM + 0] = 127;          // row 0 → photo 1
  rows[1 * DIM + 1] = 127;          // row 1 → photo 2
  const shard = await ingest(`/api/internal/shards/${shardKey}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: rows,
  });
  check(shard.ok, 'shard upload to the private bucket', `status=${shard.status}`);

  const facesBody = {
    shard_key: shardKey, row_base: 0, row_count: 2, replace: true,
    rows: [
      { photo_id: photoIds.smokefile0001, row_idx: 0, bbox: [10, 10, 100, 100] },
      { photo_id: photoIds.smokefile0002, row_idx: 1, bbox: [20, 20, 100, 100] },
    ],
  };
  const f1 = await ingest(`/api/internal/events/${eventId}/faces`, { method: 'POST', body: JSON.stringify(facesBody) });
  check(f1.ok, 'faces write', `status=${f1.status}`);

  // C7: the runner retries this POST on any transport error, including a timeout
  // that arrived after the batch already committed.
  const f2 = await ingest(`/api/internal/events/${eventId}/faces`, {
    method: 'POST', body: JSON.stringify({ ...facesBody, replace: false }),
  });
  check(f2.ok, 'C7  a replayed /faces POST is idempotent, not a 500', `status=${f2.status}`);

  await ingest(`/api/internal/events/${eventId}/photos/complete`, {
    method: 'POST', body: JSON.stringify({ photo_ids: Object.values(photoIds) }),
  });
  const idx1 = await json(await ingest(`/api/internal/events/${eventId}/indexed`));
  check(idx1?.drive_file_ids?.length === 2, 'C4  completed photos become resumable', JSON.stringify(idx1));

  // --- bibs ----------------------------------------------------------------
  console.log('\nBibs');
  const bibsRes = await ingest(`/api/internal/events/${eventId}/bibs`, {
    method: 'POST',
    body: JSON.stringify({
      replace_photos: Object.values(photoIds),
      bibs: [{ photo_id: p1, bib: '123', bib_raw: '0123', conf: 0.9 }],
    }),
  });
  // C1: this route reads bib_rejects on EVERY bib-writing batch. Without the table
  // it 500s and the runner fails the whole job after five retries.
  check(bibsRes.ok, 'C1  bib write reads bib_rejects (missing table → 500)', `status=${bibsRes.status}`);

  const del = await admin(`/api/admin/photos/${p1}/bibs/123`, { method: 'DELETE' });
  check(del.ok, 'C1  deleting a bib writes a bib_rejects tombstone', `status=${del.status}`);

  const reread = await ingest(`/api/internal/events/${eventId}/bibs`, {
    method: 'POST', body: JSON.stringify({ bibs: [{ photo_id: p1, bib: '123', bib_raw: '0123', conf: 0.9 }] }),
  });
  const rereadBody = await json(reread);
  check(rereadBody?.rejected === 1,
        'C1  a re-read cannot resurrect a rejected bib', JSON.stringify(rereadBody));

  // --- publish and query ---------------------------------------------------
  console.log('\nPublic API');
  await ingest(`/api/internal/events/${eventId}/finalize`, { method: 'POST', body: JSON.stringify({ status: 'ready' }) });

  // C6: finalize must not move a draft onto the public site. The event was created
  // as a draft and /ingest only promotes draft → indexing when the dispatch works,
  // so assert against whatever it is now rather than guessing.
  const stateBefore = (await json(await admin(`/api/admin/events/${eventId}`)))?.event?.status;
  await admin(`/api/admin/events/${eventId}`, { method: 'PATCH', body: JSON.stringify({ status: 'draft' }) });
  await ingest(`/api/internal/events/${eventId}/finalize`, { method: 'POST', body: JSON.stringify({ status: 'ready' }) });
  const stateAfter = (await json(await admin(`/api/admin/events/${eventId}`)))?.event?.status;
  check(stateAfter === 'draft',
        'C6  finalize does not republish an unpublished event',
        `was ${stateBefore}, set to draft, finalize left it ${stateAfter}`);

  await admin(`/api/admin/events/${eventId}`, { method: 'PATCH', body: JSON.stringify({ status: 'ready' }) });

  const page = await json(await fetch(`${API}/api/events/${EVENT_SLUG}/photos?limit=-1`));
  check(Array.isArray(page?.photos) && page.photos.length <= 60,
        'P4  ?limit=-1 falls back instead of returning every row',
        `returned ${page?.photos?.length}`);

  const search = await json(await fetch(`${API}/api/events/${EVENT_SLUG}/search/face?t=-1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vec: oneHot(0) }),
  }));
  const top = search?.matches?.[0];
  check(top?.photo?.id === p1 && Math.abs(top.score - 1) < 1e-6,
        'face search returns the matching photo at score 1.0',
        JSON.stringify(search?.matches?.map((m) => [m.photo.id, m.score])));
  check((search?.matches?.length ?? 0) < 2,
        'P5  ?t=-1 is clamped, not "match everything"',
        `${search?.matches?.length} matches`);

  const bibSearch = await json(await fetch(`${API}/api/events/${EVENT_SLUG}/bib/0123`));
  check(bibSearch?.photos?.length === 0,
        'a rejected bib stays unfindable', JSON.stringify(bibSearch?.photos?.length));

  // --- security regressions -------------------------------------------------
  console.log('\nSecurity');
  const fd = new FormData();
  fd.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'], { type: 'image/svg+xml' }), 'x.svg');
  const svg = await fetch(`${API}/api/admin/events/${eventId}/banner`, { method: 'POST', body: fd });
  check((await json(svg))?.code === 'bad_type',
        'S2  an SVG banner is refused (it would execute on the image domain)', `status=${svg.status}`);

  const badSecret = await fetch(`${API}/api/internal/events/${eventId}/finalize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': 'wrong' }, body: '{}',
  });
  check(badSecret.status === 401, 'internal API rejects a bad ingest secret', `status=${badSecret.status}`);

  console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall checks passed\x1b[0m'}\n`);
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`\nsmoke test crashed: ${e.stack ?? e}\n`);
  process.exit(1);
});
