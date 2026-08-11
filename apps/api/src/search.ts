import type { Env } from './types';
import { chunk, publicPhoto } from './lib';

/**
 * Vector format contract — must match indexer/faces.py exactly.
 *
 *   embedding is L2-normalized float32[512]
 *   int8[i] = clamp(round(f[i] * 127), -127, 127)
 *   a shard is a flat little-endian int8 array, row_count * 512 bytes, no header
 *
 * Ranking uses the raw int8 dot product: the quantization scale is a positive
 * constant, so it cannot change the ordering. We only divide by 127*127 at the
 * very end to turn the score back into a cosine for thresholding.
 */
export const DIM = 512;
export const SCALE = 127;

/** D1's hard cap on bound parameters per query. Not SQLite's 999. */
export const D1_MAX_PARAMS = 100;

/** Structural: Hono's executionCtx and workers-types' ExecutionContext differ. */
type Waiter = { waitUntil(p: Promise<unknown>): void };

export function quantize(vec: number[]): Int8Array {
  const out = new Int8Array(DIM);
  // Re-normalize defensively: a browser-side embedding that is off by a few
  // percent would otherwise shift every score by the same factor.
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) {
    const q = Math.round((vec[i] / norm) * SCALE);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
}

interface ShardMeta { shard_key: string; row_base: number; row_count: number }

interface CachedIndex {
  rows: Int8Array;      // concatenated, indexed by global row_idx * DIM
  rowCount: number;     // highest row_base + row_count
  loadedAt: number;
}

// Module scope survives across requests in a warm isolate. Refetching 15 MB
// from R2 per request is the difference between ~20 ms and ~400 ms.
const memCache = new Map<string, CachedIndex>();
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * How many event indexes may sit in isolate memory at once.
 *
 * ONE, not two. Measured against production on 2026-08-11:
 *
 *     angkor11_wupmrk   1006 shards   160,214 rows   82.0 MB
 *     qh1VYQ3HGN6I        46 shards     8,197 rows    4.2 MB
 *     d5URgH0h2F2C        13 shards     2,594 rows    1.3 MB
 *
 * A row is 512 int8, so an event costs `rows × 512`. The previous value of two
 * was sized against "78,382 faces = 38.3 MB", which the album has since doubled
 * past — two Angkor-sized indexes is 164 MB against a 128 MB isolate, so the
 * budget was already blown before anything transient was counted.
 *
 * At 82 MB apiece there is no honest way to hold two. The colo-wide Cache API in
 * fetchSegment is what actually serves the runner comparing two races: it has no
 * such ceiling, and a second event's shards come back from the edge rather than
 * from R2.
 *
 * The TTL above governs freshness, not residency — an entry is only ever re-read
 * or overwritten under its own key, so without eviction every event ever searched
 * in a warm isolate would stay resident forever.
 */
const MAX_CACHED_INDEXES = 1;

/**
 * Evict least-recently-used entries until the cache is within budget.
 *
 * Map iterates in insertion order, and `touch` re-inserts on every hit, so the
 * first key is always the least recently used.
 */
function evictTo(limit: number): void {
  while (memCache.size > limit) {
    const oldest = memCache.keys().next();
    if (oldest.done) break;
    memCache.delete(oldest.value);
  }
}

/** Move an entry to the most-recently-used end of the map. */
function touch(eventId: string, idx: CachedIndex): CachedIndex {
  memCache.delete(eventId);
  memCache.set(eventId, idx);
  return idx;
}

/**
 * Fetch one SEGMENT of a shard, preferring the colo's edge cache over R2.
 *
 * A segment rather than a whole object, because object size and read latency are not
 * the same problem. Compacting Angkor's 1023 shards into one 83 MB object cut the
 * operation count by three orders of magnitude and made cold search WORSE — measured
 * 2281/4033/11650 ms against 1056-1297 for the shards it replaced. One object is one
 * sequential stream; a thousand were a thousand parallel ones. Bandwidth, not
 * per-request overhead, is what dominates here.
 *
 * So large objects are read as parallel ranges, which keeps compaction's win (far
 * fewer objects, no unbounded growth per continuation pass) without paying for it in
 * latency. Small shards are a single segment and behave exactly as before.
 *
 * The cache key includes the range, so a segment is cacheable independently. Shards
 * are immutable per (event, source) — a re-index writes a new key — so a long TTL is
 * safe.
 */
async function fetchSegment(
  env: Env, key: string, offset: number, length: number, ctx?: Waiter,
): Promise<Int8Array | null> {
  // Synthetic key: shards are not reachable over HTTP, we only need a stable URL.
  const cacheKey = new Request(
    `https://shards.race-lens.internal/${encodeURIComponent(key)}?o=${offset}&l=${length}`,
  );
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return new Int8Array(await hit.arrayBuffer());

  // INDEX_BUCKET only.
  //
  // Shards live in their own private bucket so that BUCKET could be given a custom
  // domain — an R2 custom domain publishes the ENTIRE bucket, and these objects are
  // raw face embeddings, one row per detected face.
  //
  // There used to be a `?? env.BUCKET.get(key)` fallback here for events indexed
  // before that split. Verified on 2026-08-11 with `ListObjectsV2` on the public
  // bucket: zero objects under `index/`. So the fallback could only ever return
  // null, which makes removing it a no-op for behaviour.
  //
  // Do not reintroduce it. It was the one code path that could serve a biometric
  // vector out of a bucket published at img.runlytics.fit, and its existence was
  // also the reason nobody would have noticed a leftover sitting there.
  // tools/check-index-leak.py re-runs that check.
  const obj = await env.INDEX_BUCKET.get(key, { range: { offset, length } });
  if (!obj) return null;
  const buf = await obj.arrayBuffer();

  const store = new Response(buf, {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' },
  });
  if (ctx) ctx.waitUntil(cache.put(cacheKey, store));
  else await cache.put(cacheKey, store);

  return new Int8Array(buf);
}

/** One contiguous read: which object, which byte range, and where it lands in `rows`. */
interface Segment { key: string; offset: number; length: number; destByte: number }

/**
 * Split the shard list into read units of at most SEGMENT_BYTES.
 *
 * 4 MB is a deliberate middle: large enough that per-request overhead is amortised,
 * small enough that a 83 MB index becomes ~21 parallel reads rather than one stream.
 */
const SEGMENT_BYTES = 4 * 1024 * 1024;

function planSegments(shards: ShardMeta[]): Segment[] {
  const out: Segment[] = [];
  for (const s of shards) {
    const total = s.row_count * DIM;
    const base = s.row_base * DIM;
    for (let off = 0; off < total; off += SEGMENT_BYTES) {
      out.push({
        key: s.shard_key,
        offset: off,
        length: Math.min(SEGMENT_BYTES, total - off),
        destByte: base + off,
      });
    }
  }
  return out;
}

async function loadIndex(env: Env, eventId: string, ctx?: Waiter): Promise<CachedIndex | null> {
  const hit = memCache.get(eventId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return touch(eventId, hit);
  // Stale but still resident: drop it now rather than holding 38 MB of dead
  // weight while the replacement is fetched.
  if (hit) memCache.delete(eventId);

  const { results: shards } = await env.DB.prepare(
    'SELECT shard_key, row_base, row_count FROM face_shards WHERE event_id = ? ORDER BY row_base',
  ).bind(eventId).all<ShardMeta>();
  if (!shards.length) return null;

  const total = shards.reduce((m, s) => Math.max(m, s.row_base + s.row_count), 0);

  // Make room BEFORE allocating, because eviction below happens after insertion.
  //
  // MAX_CACHED_INDEXES was budgeted against resident copies only, and that is off by
  // one whole index. Loading a third event allocates `rows` (38.3 MB for Angkor)
  // while the shard buffers are also live — together exactly one row per face, so
  // another 38.3 MB — on top of the two entries still cached (76.6 MB). Peak ~153 MB
  // against a 128 MB isolate. The isolate is killed mid-search: the runner sees a
  // failed search AND the whole warm cache goes with it, so the next several
  // searches pay 400-1200 ms cold R2 reads.
  evictTo(MAX_CACHED_INDEXES - 1);
  const rows = new Int8Array(total * DIM);

  // Windowed, and the window has to be WIDE. Measured on production, cold, loadMs:
  //
  //     unbounded (1023 objects at once)   23865, 1089, 1409, 938
  //     IN_FLIGHT = 64                      7193, 22161, 2159
  //     IN_FLIGHT = 256                     1001, 1064, 1417, 0*, 1417   (* memCache hit)
  //
  // A narrow window is a trap that cost a production outage: the comment that used to
  // sit here claimed shard count was "small (one per source folder)", when the indexer
  // writes one per BATCH of 25 photos — 1023 for Angkor. A window of 2 is 500+
  // sequential round trips and a cold search stopped answering inside 120 s.
  //
  // Reads are now segments rather than whole objects, so this bounds concurrent
  // in-flight bytes at IN_FLIGHT * SEGMENT_BYTES worst case. With 4 MB segments that
  // is why the count is lower than the 256 measured above: 32 * 4 MB = 128 MB of
  // potential buffers would be as bad as the bug this replaced, so keep the product
  // modest and let the segment count supply the parallelism.
  const IN_FLIGHT = 16;
  const segments = planSegments(shards);
  for (let i = 0; i < segments.length; i += IN_FLIGHT) {
    const window = segments.slice(i, i + IN_FLIGHT);
    const bufs = await Promise.all(
      window.map((seg) => fetchSegment(env, seg.key, seg.offset, seg.length, ctx)),
    );
    for (let j = 0; j < window.length; j++) {
      const buf = bufs[j];
      if (!buf) continue;
      const seg = window[j];
      // A short read means a truncated upload; take what is there rather than
      // throwing, so one bad source cannot break search for the whole event.
      rows.set(buf.subarray(0, Math.min(buf.length, seg.length)), seg.destByte);
    }
  }

  const idx: CachedIndex = { rows, rowCount: total, loadedAt: Date.now() };
  memCache.set(eventId, idx);
  // Evict AFTER inserting, so the entry this request needs is never the one
  // dropped — it is now the most recently used.
  evictTo(MAX_CACHED_INDEXES);
  return idx;
}

/** Drop the cached index for an event. Called after a job finalizes. */
export function invalidateIndex(eventId: string): void {
  memCache.delete(eventId);
}

/**
 * NOTE ON scanMs: it will always read 0.
 *
 * Workers freezes Date.now() during synchronous execution (a Spectre timing
 * mitigation) — the clock only advances on I/O. So pure CPU is unmeasurable
 * from inside the isolate, and only loadMs/joinMs, which straddle I/O, mean
 * anything. Do not go looking for a bug here.
 */
export interface SearchTiming {
  loadMs: number;   // shard fetch (R2 or edge cache)
  scanMs: number;   // brute-force dot product
  joinMs: number;   // D1 lookup of matched rows
  totalMs: number;
  rows: number;
  cached: boolean;  // served from the in-isolate module cache
}

export interface FaceMatch {
  photo: ReturnType<typeof publicPhoto>;
  score: number;
  bbox: [number, number, number, number];
}

export async function searchFaces(
  env: Env,
  eventId: string,
  vec: number[],
  opts: { threshold?: number; topFaces?: number; topPhotos?: number; ctx?: Waiter } = {},
): Promise<{ matches: FaceMatch[]; timing: SearchTiming }> {
  const t0 = Date.now();
  const threshold = opts.threshold ?? 0.38;
  const topFaces = opts.topFaces ?? 200;
  const topPhotos = opts.topPhotos ?? 60;

  const warm = memCache.has(eventId);
  const index = await loadIndex(env, eventId, opts.ctx);
  const tLoad = Date.now();
  if (!index) {
    return { matches: [], timing: { loadMs: tLoad - t0, scanMs: 0, joinMs: 0, totalMs: tLoad - t0, rows: 0, cached: warm } };
  }

  const q = quantize(vec);
  const { rows, rowCount } = index;

  // Fixed-size min-heap would be tidier, but at 30k rows a plain scan plus a
  // partial selection is already well under a millisecond of the budget.
  const scores = new Int32Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    const base = r * DIM;
    let dot = 0;
    for (let i = 0; i < DIM; i++) dot += rows[base + i] * q[i];
    scores[r] = dot;
  }

  const tScan = Date.now();
  const cutoff = threshold * SCALE * SCALE;
  const candidates: number[] = [];
  for (let r = 0; r < rowCount; r++) if (scores[r] >= cutoff) candidates.push(r);
  candidates.sort((a, b) => scores[b] - scores[a]);
  const top = candidates.slice(0, topFaces);
  const mkTiming = (end: number, joinStart: number): SearchTiming => ({
    loadMs: tLoad - t0,
    scanMs: tScan - tLoad,
    joinMs: end - joinStart,
    totalMs: end - t0,
    rows: rowCount,
    cached: warm,
  });
  if (!top.length) {
    const now = Date.now();
    return { matches: [], timing: mkTiming(now, now) };
  }

  // D1 allows at most 100 bound parameters per query — far below SQLite's 999.
  // topFaces is 200, so this MUST be chunked; binding them in one statement
  // throws "too many SQL variables" on every search with enough matches, which
  // is exactly the case that matters.
  // Issued as one D1 batch rather than sequential awaits: 200 candidates is
  // three chunks, and serialised they cost three full round trips (~75 ms
  // measured) for what is one round trip's worth of work.
  const parts = chunk(top, D1_MAX_PARAMS - 1);
  const pages = await env.DB.batch<any>(
    parts.map((part) =>
      env.DB.prepare(
        // The removed-source clause matches the one in public.ts: a withdrawn link
        // is unsearchable from the moment it is withdrawn, not from whenever the
        // batched purge of its photos happens to finish. Its vectors are still in
        // the shards this scan read — the join is what drops them.
        `SELECT f.row_idx, f.bbox, p.id, p.drive_file_id, p.thumb_key, p.width, p.height, p.taken_at
           FROM faces f JOIN photos p ON p.id = f.photo_id
          WHERE f.event_id = ? AND f.row_idx IN (${part.map(() => '?').join(',')})
            AND NOT EXISTS (
              SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.removed_at IS NOT NULL)`,
      ).bind(eventId, ...part),
    ),
  );
  const results: any[] = pages.flatMap((p) => p.results ?? []);

  // Collapse to the best-scoring face per photo — a runner appearing twice in
  // one frame should not produce two grid tiles.
  const best = new Map<string, FaceMatch>();
  for (const row of results) {
    const score = scores[row.row_idx] / (SCALE * SCALE);
    const prev = best.get(row.id);
    if (prev && prev.score >= score) continue;
    best.set(row.id, {
      photo: publicPhoto(env, row),
      score,
      bbox: JSON.parse(row.bbox),
    });
  }

  return {
    matches: [...best.values()].sort((a, b) => b.score - a.score).slice(0, topPhotos),
    timing: mkTiming(Date.now(), tScan),
  };
}
