/**
 * bannerType and bannerKey — the two guards on the one user-writable path into
 * the public bucket.
 *
 * That bucket is published whole at img.runlytics.fit, and every object in it is
 * written `immutable, max-age=31536000`. Two separate things follow from that, and
 * both were wrong at some point:
 *
 *   bannerType  the stored content type is served verbatim, so `image/svg+xml`
 *               meant script execution on a runlytics.fit origin. Pinned as an
 *               allowlist so widening it can never be an accident.
 *   bannerKey   `immutable` is a promise that a URL's bytes never change. The old
 *               `banners/<event_id>.webp` broke it on every replacement. Verified
 *               on 2026-08-13: a live banner was serving with `age: 247756`.
 *
 * The staleness itself is not observable from inside the Worker — the write
 * succeeds either way and the wrong bytes are served by a cache we cannot see. So
 * what is pinned is the property that makes it impossible: different bytes, and
 * only different bytes, produce a different key.
 */
import { bannerType, bannerKey } from '../src/banner.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) console.log(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
};

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

console.log('bannerType:');

check('webp passes through', bannerType('image/webp'), { contentType: 'image/webp', ext: 'webp' });
check('png passes through', bannerType('image/png'), { contentType: 'image/png', ext: 'png' });
check('avif passes through', bannerType('image/avif'), { contentType: 'image/avif', ext: 'avif' });

// Both spellings arrive from real clients, and both must normalise to the one
// string we are willing to write — never the caller's.
check('image/jpg normalises to image/jpeg', bannerType('image/jpg'),
  { contentType: 'image/jpeg', ext: 'jpg' });
check('image/jpeg keeps the .jpg extension', bannerType('image/jpeg'),
  { contentType: 'image/jpeg', ext: 'jpg' });

// A browser sends `image/jpeg; charset=...` more often than you would think, and
// case is not guaranteed by anything.
check('parameters are stripped', bannerType('image/png; charset=binary'),
  { contentType: 'image/png', ext: 'png' });
check('leading space and mixed case are tolerated', bannerType('  IMAGE/WebP '),
  { contentType: 'image/webp', ext: 'webp' });

/*
 * The vulnerability, stated as a test. Each of these passed a
 * `startsWith('image/')` check.
 */
check('svg is refused', bannerType('image/svg+xml'), null);
check('svg with parameters is refused', bannerType('image/svg+xml; charset=utf-8'), null);
check('html masquerading as an image type is refused', bannerType('text/html'), null);
check('a made-up image subtype is refused', bannerType('image/x-anything'), null);
check('an absent type is refused, not defaulted', bannerType(''), null);
check('a missing type is refused', bannerType(null), null);
check('a prefix-only match is refused', bannerType('image/'), null);

console.log('\nbannerKey:');

const a = await bannerKey('EV1', bytes('alpha'), 'webp');
const b = await bannerKey('EV1', bytes('bravo'), 'webp');

check('the event id stays a path segment, so prefix listing still works',
  a.startsWith('banners/EV1/'), true);
check('the extension matches the resolved type', a.endsWith('.webp'), true);
check('the name is 128 bits of hex', /^banners\/EV1\/[0-9a-f]{32}\.webp$/.test(a), true);

// The whole point: this is what the old key could not do.
check('different bytes produce a different key', a === b, false);
check('identical bytes produce the same key',
  a === await bannerKey('EV1', bytes('alpha'), 'webp'), true);

// Not cosmetic — the upload path compares the new key against the stored one to
// decide whether to delete the previous object. If a re-upload of the same image
// produced a fresh key, the comparison would delete nothing and orphan on every
// write; if two events collided, one would delete the other's banner.
check('the same bytes under a different event do not collide',
  a === await bannerKey('EV2', bytes('alpha'), 'webp'), false);

// A recompressed copy is different bytes and gets a different URL. That is the
// correct outcome, not a missed dedupe: the bytes are what the cache holds.
check('a one-byte difference is enough',
  await bannerKey('EV1', bytes('alpha'), 'webp') === await bannerKey('EV1', bytes('alphb'), 'webp'),
  false);

// Extension is part of the key, so the same image stored as two types is two
// objects. Harmless, and it keeps key and content type from ever disagreeing.
check('the extension participates in the key',
  a === await bannerKey('EV1', bytes('alpha'), 'jpg'), false);

console.log(fail ? `\n${fail} FAILURES` : '\nall cases pass');
process.exit(fail ? 1 : 0);
