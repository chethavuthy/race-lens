import type { Env, EventRow } from './types';

/** URL-safe id generator. nanoid-compatible alphabet, no dependency at runtime. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-';
export function newId(size = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Constant-time string compare. A plain `===` on the ingest secret leaks its
 * prefix through timing; the runner calls this on every batch, so there is
 * plenty of signal to average over.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/** Public URL for an R2 key: custom domain if configured, else through the Worker. */
export function r2Url(env: Env, key: string | null): string | null {
  if (!key) return null;
  const base = (env.R2_PUBLIC_BASE || '').replace(/\/+$/, '');
  return base ? `${base}/${key}` : `/r2/${key}`;
}

export function publicEvent(env: Env, e: EventRow) {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    event_date: e.event_date,
    banner_url: r2Url(env, e.banner_key),
    status: e.status,
    photo_count: e.photo_count,
    face_count: e.face_count,
    // Exposed publicly so the event page knows not to offer bib search. Sent as
    // a boolean because SQLite has no bool and every consumer wants one.
    bibs_enabled: e.bibs_enabled !== 0,
  };
}

export function publicPhoto(env: Env, p: {
  id: string; drive_file_id: string; thumb_key: string;
  width: number | null; height: number | null; taken_at: string | null;
}) {
  return {
    id: p.id,
    thumb_url: r2Url(env, p.thumb_key),
    // `uc?id=` is deprecated and now bounces through a confirm page for large
    // files. /file/d/<id>/view is the stable viewer link.
    original_url: `https://drive.google.com/file/d/${p.drive_file_id}/view`,
    width: p.width,
    height: p.height,
    taken_at: p.taken_at,
  };
}

/**
 * D1 statements are bound one at a time, but SQLite still caps a single
 * statement at 999 bound parameters. Chunk multi-row inserts accordingly.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A page size from an untrusted query param that cannot become "no limit".
 *
 * `Math.min(Number(q) || fallback, max)` reads as safe and is not. SQLite treats a
 * NEGATIVE LIMIT as unbounded, and `Number('-1')` is truthy, so `?limit=-1`
 * survived the `||`, survived `Math.min(-1, 200)`, and reached SQL as `LIMIT -1` —
 * one unauthenticated GET returning every photo row in the event. The 200 ceiling
 * was defeated by a minus sign.
 *
 * Floor, because `LIMIT 1.5` is not a thing, and reject anything below 1 rather
 * than clamping up to it: a caller asking for 0 rows has made a mistake, and the
 * fallback is the more useful answer than an empty page that also ends pagination.
 */
export function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Cosine threshold from an untrusted query param, clamped to a usable band.
 *
 * `Number.isFinite` alone is not enough in either direction. Below zero the scan's
 * cutoff goes negative, every row in the index becomes a candidate, and the
 * candidate array is fully sorted — on a public, unauthenticated, unrated endpoint
 * that already does 40M multiply-adds per call. And anything near zero returns
 * strangers as matches, which is the one thing this product must never do; a
 * shared URL carrying `?t=0` would do it silently.
 *
 * 0.2 is comfortably below the 0.38 default the UI uses, so widening a search by
 * hand still works — it just cannot reach "match everyone".
 */
export function clampThreshold(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0.2), 1);
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
