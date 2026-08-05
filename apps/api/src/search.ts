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
 * Fetch one shard, preferring the colo's edge cache over R2.
 *
 * Module scope only helps when the same warm isolate serves the next request,
 * which is far from guaranteed — measured cold, a 14.65 MB R2 read costs
 * 400-1200 ms versus ~25 ms for the scan itself. The Cache API is shared by
 * every isolate in the colo, so it turns most of those misses into local reads.
 */
async function fetchShard(env: Env, key: string, ctx?: Waiter): Promise<Int8Array | null> {
  // Synthetic key: shards are not reachable over HTTP, we only need a stable URL.
  const cacheKey = new Request(`https://shards.race-lens.internal/${encodeURIComponent(key)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return new Int8Array(await hit.arrayBuffer());

  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();

  // Shards are immutable per (event, source): a re-index writes a new object or
  // the same bytes, so a long TTL is safe.
  const store = new Response(buf, {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' },
  });
  if (ctx) ctx.waitUntil(cache.put(cacheKey, store));
  else await cache.put(cacheKey, store);

  return new Int8Array(buf);
}

async function loadIndex(env: Env, eventId: string, ctx?: Waiter): Promise<CachedIndex | null> {
  const hit = memCache.get(eventId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit;

  const { results: shards } = await env.DB.prepare(
    'SELECT shard_key, row_base, row_count FROM face_shards WHERE event_id = ? ORDER BY row_base',
  ).bind(eventId).all<ShardMeta>();
  if (!shards.length) return null;

  const total = shards.reduce((m, s) => Math.max(m, s.row_base + s.row_count), 0);
  const rows = new Int8Array(total * DIM);

  // Parallel fetch: shard count is small (one per source folder).
  const bodies = await Promise.all(
    shards.map(async (s) => {
      const buf = await fetchShard(env, s.shard_key, ctx);
      return buf ? { s, buf } : null;
    }),
  );

  for (const entry of bodies) {
    if (!entry) continue;
    const { s, buf } = entry;
    const expected = s.row_count * DIM;
    // A short shard means a truncated upload; take what is there rather than
    // throwing, so one bad source cannot break search for the whole event.
    rows.set(buf.subarray(0, Math.min(buf.length, expected)), s.row_base * DIM);
  }

  const idx: CachedIndex = { rows, rowCount: total, loadedAt: Date.now() };
  memCache.set(eventId, idx);
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
        `SELECT f.row_idx, f.bbox, p.id, p.drive_file_id, p.thumb_key, p.width, p.height, p.taken_at
           FROM faces f JOIN photos p ON p.id = f.photo_id
          WHERE f.event_id = ? AND f.row_idx IN (${part.map(() => '?').join(',')})`,
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
