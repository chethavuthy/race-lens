/**
 * faceBox and bboxFitsFrame — the coordinate-space contract, from the read side.
 *
 * On 2026-08-09 the indexer measured faces in Drive's w3200 copy while recording
 * the 6000px original's dimensions. Every box came out ~2.2x too small and pulled
 * toward the top-left, and nothing failed: the fractions stayed in 0..1, the admin
 * overlay drew them faithfully, and the crop still captioned itself "cropped to
 * you". 8,000 photos were wrong for two days.
 *
 * indexer/tests/test_thumbnail_dims.py now pins the WRITE side — the dimensions
 * recorded must equal the array the detector saw. This file pins the other two
 * halves, which had no test at all:
 *
 *   faceBox        the single conversion both read paths use, so there is one
 *                  denominator in the system rather than one per consumer
 *   bboxFitsFrame  the ingest guard, so a writer that disagrees fails the pass
 *
 * The mismatch itself cannot be caught per box — a box in the wrong space is
 * still a valid rectangle. What can be caught is the half of the divergence that
 * OVERFLOWS, and it comes from the same cause, so rejecting it stops the writer.
 */
import { faceBox, bboxFitsFrame, BBOX_TOLERANCE } from '../src/bbox.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) console.log(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
};

console.log('faceBox:');

check(
  'a centred box on a 1000x500 frame',
  faceBox([250, 100, 500, 200], 1000, 500),
  { x: 0.25, y: 0.2, w: 0.5, h: 0.4 },
);

// The detector rounds, so a box can end a pixel or two past the edge. Clamped
// rather than rejected: the face is real, only the arithmetic overshot.
check(
  'a box overshooting the edge is clamped into 0..1',
  faceBox([990, 495, 20, 20], 1000, 500),
  { x: 0.99, y: 0.99, w: 0.02, h: 0.04 },
);

check('negative coordinates clamp to 0', faceBox([-4, -2, 100, 50], 1000, 500),
  { x: 0, y: 0, w: 0.1, h: 0.1 });

// Legacy rows exist with no dimensions recorded. Returning null makes the caller
// show the whole photograph — the one safe answer. A fallback of 1 (the old
// `p.width || 1` in admin.ts) turned every such box into a full-frame overlay.
check('no dimensions yields null, not a guess', faceBox([10, 10, 20, 20], null, null), null);
check('a zero dimension yields null', faceBox([10, 10, 20, 20], 0, 500), null);
check('a garbage bbox yields null', faceBox([NaN, 0, 10, 10], 1000, 500), null);

/*
 * The regression itself, stated as arithmetic.
 *
 * Photo -3aJzdlLafV9 as production held it: nine faces measured in the 3200px
 * space, dimensions recorded as 7008x4672. The rightmost face sat at x=2554.
 */
const WRONG = faceBox([2554, 541, 33, 46], 7008, 4672)!;
const RIGHT = faceBox([2554, 541, 33, 46], 3200, 2133)!;
check('the 2026-08-09 mismatch put that face at 36% of the width', Math.round(WRONG.x * 100), 36);
check('...when the runner was actually at 80%', Math.round(RIGHT.x * 100), 80);

console.log('\nbboxFitsFrame:');

check('a box inside the frame fits', bboxFitsFrame([100, 100, 200, 200], 1000, 500), true);
check('a box filling the frame fits', bboxFitsFrame([0, 0, 1000, 500], 1000, 500), true);

/*
 * The case that made the first version of this guard dangerous.
 *
 * SCRFD predicts the whole face box even when the frame cuts through it, so a
 * runner at the bottom edge legitimately overshoots. Production's eight real
 * examples are all this shape — a 2048x1365 frame with a box ending 3.7% to 6.6%
 * of the long edge past the bottom. A 2% tolerance rejected them, and rejecting a
 * batch fails the pass, so eight faces standing near an edge would have killed a
 * 27,000-photo album.
 */
check('a face cropped by the bottom edge fits',
  bboxFitsFrame([900, 1280, 180, 220], 2048, 1365), true);
check('...and so does the worst real overshoot, 6.6% of the long edge',
  bboxFitsFrame([900, 1300, 180, 200], 2048, 1365), true);

const slack = Math.max(1000, 500) * BBOX_TOLERANCE;
check('a box over by less than the tolerance fits',
  bboxFitsFrame([0, 0, 1000 + slack / 2, 500], 1000, 500), true);

/*
 * The overflow half of the same divergence: a source toggled to 'original' after
 * indexing, so boxes measured in the 6224px frame were checked against Drive's
 * numbers for a smaller file. This is the case the guard actually catches, and
 * catching it stops the writer that produces both halves.
 */
// 6224px-space boxes against a 3200px frame: 95% over, versus 6.6% for the
// honest overshoot above. Two orders of magnitude apart, which is what lets one
// threshold separate them.
check('a box measured in a larger space is rejected',
  bboxFitsFrame([4000, 200, 300, 300], 3200, 2133), false);
check('a box far past the bottom edge is rejected',
  bboxFitsFrame([10, 4000, 50, 200], 3200, 2133), false);
check('a far-negative box is rejected', bboxFitsFrame([-1200, 10, 50, 50], 3200, 2133), false);
check('a zero-area box is rejected', bboxFitsFrame([10, 10, 0, 50], 3200, 2133), false);
check('a garbage box is rejected', bboxFitsFrame([10, 10, NaN, 50], 3200, 2133), false);

// A photo with no recorded dimensions cannot contradict anything, and refusing
// the write would block a whole album over one missing EXIF field.
check('an unmeasurable frame is not treated as a failure',
  bboxFitsFrame([10, 10, 50, 50], null, null), true);

console.log(fail ? `\n${fail} FAILURES` : '\nall cases pass');
process.exit(fail ? 1 : 0);
