/**
 * pruneRefusal — the only thing standing between a tidy-up and a deleted album.
 *
 * Pruning exists because indexing is otherwise additive: a photographer who
 * removed photos from their Drive folder left Race Lens serving rows,
 * thumbnails and face vectors for files that were already gone.
 *
 * The hazard is that Drive cannot tell us the difference between the two states
 * that matter. A listing of a folder that has been DELETED or UNSHARED comes
 * back HTTP 200 with an empty `files` array — byte for byte what a genuinely
 * emptied folder returns. KAIIA RUPP's second link sits in the first state
 * today: 510 published photos, and a folder id that files.get answers 404 for.
 * Pruning on that listing would delete the album and its face index outright.
 *
 * So this function is deliberately biased. Refusing costs stale photos on a page
 * until someone looks; allowing wrongly costs an album with nothing to restore
 * it from.
 */
import { strict as assert } from 'node:assert';
import { pruneRefusal, PRUNE_MAX_SHARE } from '../src/prune.ts';

function test(name: string, fn: () => void): void {
  fn();
  console.log(`  ok  ${name}`);
}

console.log('pruneRefusal');

test('allows the handful a real tidy-up removes', () => {
  assert.equal(pruneRefusal(3, 315), null);
});

test('refuses a prune that would empty the link', () => {
  // The KAIIA RUPP shape: the folder 404s, so the walk sees nothing and every
  // photo looks stale.
  const reason = pruneRefusal(510, 510);
  assert.ok(reason, 'a whole-link prune must be refused');
  assert.match(reason!, /510 of 510/);
});

test('refuses a link with no photos rather than dividing by it', () => {
  assert.ok(pruneRefusal(0, 0));
  assert.ok(pruneRefusal(5, 0));
});

test('holds the line exactly at the ceiling', () => {
  // Half is allowed, one photo past it is not — pinned so the boundary cannot
  // drift into strictness or laxity unnoticed.
  assert.equal(PRUNE_MAX_SHARE, 0.5);
  assert.equal(pruneRefusal(50, 100), null);
  assert.ok(pruneRefusal(51, 100));
});

test('judges the whole prune, not the chunk in hand', () => {
  // The runner sends ids 90 at a time. Each chunk of a 510-photo prune is well
  // under the ceiling on its own, so the ceiling has to be applied to the total
  // the runner declares, or a fatal prune walks straight through it.
  assert.equal(pruneRefusal(90, 510), null, 'one chunk alone looks harmless');
  assert.ok(pruneRefusal(510, 510), 'the declared total is what is judged');
});

console.log('all prune tests passed');
