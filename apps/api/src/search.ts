import type { Env } from './types';
import { publicPhoto } from './lib';

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

async function loadIndex(env: Env, eventId: string): Promise<CachedIndex | null> {
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
      const obj = await env.BUCKET.get(s.shard_key);
      return obj ? { s, buf: new Int8Array(await obj.arrayBuffer()) } : null;
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

export interface FaceMatch {
  photo: ReturnType<typeof publicPhoto>;
  score: number;
  bbox: [number, number, number, number];
}

export async function searchFaces(
  env: Env,
  eventId: string,
  vec: number[],
  opts: { threshold?: number; topFaces?: number; topPhotos?: number } = {},
): Promise<FaceMatch[]> {
  const threshold = opts.threshold ?? 0.38;
  const topFaces = opts.topFaces ?? 200;
  const topPhotos = opts.topPhotos ?? 60;

  const index = await loadIndex(env, eventId);
  if (!index) return [];

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

  const cutoff = threshold * SCALE * SCALE;
  const candidates: number[] = [];
  for (let r = 0; r < rowCount; r++) if (scores[r] >= cutoff) candidates.push(r);
  candidates.sort((a, b) => scores[b] - scores[a]);
  const top = candidates.slice(0, topFaces);
  if (!top.length) return [];

  const placeholders = top.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT f.row_idx, f.bbox, p.id, p.drive_file_id, p.thumb_key, p.width, p.height, p.taken_at
       FROM faces f JOIN photos p ON p.id = f.photo_id
      WHERE f.event_id = ? AND f.row_idx IN (${placeholders})`,
  ).bind(eventId, ...top).all<any>();

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

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topPhotos);
}
