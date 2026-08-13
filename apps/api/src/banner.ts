/**
 * Banner storage rules: what a banner may be stored as, and what its key is.
 *
 * Its own module, not part of lib.ts, so the test can import it under
 * `node --experimental-strip-types` — lib.ts declares HttpError with a parameter
 * property, which strip-only mode refuses to parse. bbox.ts and access.ts are
 * self-contained for the same reason.
 */
/**
 * Content types a banner may be stored as, mapped to the exact string we write
 * and the extension its key gets.
 *
 * Raster formats only. Anything a browser will execute — SVG above all — must not
 * be reachable, because these objects are served from a hostname that publishes the
 * whole bucket with whatever content type is on them.
 *
 * The extension travels with the type on purpose. R2 serves the stored content
 * type and ignores the key, so a mismatch is not a security hole, but it made
 * `banners/<id>.webp` respond `image/jpeg` in production — enough to mislead
 * anyone reading a log or an object listing while debugging the real thing.
 */
const BANNER_TYPES: Record<string, { contentType: string; ext: string }> = {
  'image/webp': { contentType: 'image/webp', ext: 'webp' },
  'image/jpeg': { contentType: 'image/jpeg', ext: 'jpg' },
  'image/jpg': { contentType: 'image/jpeg', ext: 'jpg' },
  'image/png': { contentType: 'image/png', ext: 'png' },
  'image/avif': { contentType: 'image/avif', ext: 'avif' },
};

/**
 * Resolve a multipart part's declared type to one we are willing to store, or
 * null to reject.
 *
 * `raw` is attacker controlled — it is the part's own Content-Type header — so
 * this is an allowlist lookup and the caller writes the value it returns, never
 * the value it was given. A `startsWith('image/')` test here happily admitted
 * `image/svg+xml`, which then executed its own script on a runlytics.fit origin:
 * enough to set `Domain=.runlytics.fit` cookies and shadow the Access cookie the
 * admin app depends on. `nosniff` in apps/web/public/_headers is a Pages header
 * and never reaches the R2 custom domain, so this lookup is the only guard.
 */
export function bannerType(raw: string | null | undefined) {
  const key = (raw || '').split(';')[0].trim().toLowerCase();
  return BANNER_TYPES[key] ?? null;
}

/**
 * Content-addressed key for a banner: the hash of the bytes IS the name.
 *
 * Every object in the public bucket is written `immutable, max-age=31536000`,
 * which is only true if a URL's bytes can never change. The old key was
 * `banners/<event_id>.webp` — one fixed URL per event — so replacing a banner
 * wrote new bytes behind a URL that browsers and the Cloudflare edge had both
 * been told not to revalidate for a year. Verified on 2026-08-13: a production
 * banner was serving from cache with `age: 247756` (2.9 days). An organizer who
 * replaced theirs would have got a 200, then kept seeing the old image.
 *
 * Hashing removes the problem rather than papering over it. A `?v=` parameter or
 * a purge call would each need to be right on every future write path; a key
 * derived from the content cannot be wrong. R2 has no purge API of its own, and
 * the zone-level one needs a token in the request path.
 *
 * The event id stays a path segment so `list({ prefix })` still enumerates one
 * event's assets without consulting D1 — the property the flat key was chosen
 * for, and what /sources/:id purging relies on for thumbs.
 *
 * 128 bits of SHA-256. These are not adversarial inputs — a collision needs two
 * images an organizer uploaded — and a 32-char segment stays readable in a log.
 */
export async function bannerKey(eventId: string, bytes: ArrayBuffer, ext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const b of new Uint8Array(digest).subarray(0, 16)) hex += b.toString(16).padStart(2, '0');
  return `banners/${eventId}/${hex}.${ext}`;
}
