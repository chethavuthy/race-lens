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

/**
 * Cache-buster for every public asset URL. Bump when the RESPONSE HEADERS on
 * /r2/* change in a way browsers must not miss.
 *
 * These assets are served `immutable, max-age=31536000`, so a browser that has
 * one cached will not revalidate it for a year. That is the point — until a
 * header has to change. The site now sends
 * `Cross-Origin-Embedder-Policy: require-corp`, and a cached response predating
 * `Cross-Origin-Resource-Policy` is blocked outright:
 * `ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep`.
 * Every returning visitor would have seen broken photos for a year.
 *
 * Versioning the colo cache key alone does not fix it — that never reaches the
 * copy already sitting in someone's browser. The URL itself has to change.
 *
 * The cost is one re-download of each thumbnail per returning visitor, once.
 * The route keys off the path and ignores this parameter.
 */
const ASSET_URL_VERSION = '2';

/** Public URL for an R2 key: custom domain if configured, else through the Worker. */
export function r2Url(env: Env, key: string | null): string | null {
  if (!key) return null;
  const base = (env.R2_PUBLIC_BASE || '').replace(/\/+$/, '');
  const path = base ? `${base}/${key}` : `/r2/${key}`;
  return `${path}?v=${ASSET_URL_VERSION}`;
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

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
