/**
 * The face-box coordinate contract.
 *
 * Its own module, importing nothing, for the same reason indexer/resume.py is:
 * this arithmetic decides whether a crop lands on a runner or on empty road, and
 * it must be testable without the Worker runtime. apps/api/test/bbox.test.ts
 * imports it directly under node --experimental-strip-types, which cannot load
 * lib.ts at all (HttpError uses a TypeScript parameter property).
 */
/* ============================================================ face boxes ==
   faces.bbox is stored in the PIXELS of the array the detector ran on, which is
   the decoded frame — the same space photos.width/height record, enforced by
   indexer/tests/test_thumbnail_dims.py.

   Everything below exists because that pairing broke once, in the worst possible
   way. With image_source='thumb' the bytes on disk are Drive's w3200 copy, while
   the dimensions came from Drive's metadata for the 6000px original: every box
   ended up ~2.2x too small and pulled toward the top-left corner. Nothing threw.
   The numbers stayed in range, the admin overlay drew them faithfully, and the
   tile caption still said "cropped to you". It took a person looking at an
   overlay two days later to notice, and statistics over the whole table to prove.

   Two rules follow, and they are the reason this is a module and not two inline
   expressions:

     1. No CLIENT ever divides. Pixels never leave the Worker — both read paths
        call faceBox() and emit fractions of the frame, so there is exactly one
        place that can pick a denominator, and it is tested.
     2. No WRITER gets to disagree. bboxFitsFrame() is checked at ingest, so a
        space divergence fails the pass with a diagnosable message instead of
        being stored as plausible nonsense. */

/** A face box as fractions of its frame: 0..1 from the top-left. */
export interface FaceBox { x: number; y: number; w: number; h: number }

/**
 * Convert a pixel bbox to fractions of its frame.
 *
 * Clamped, because a box can legitimately sit a pixel or two outside after the
 * detector's own rounding. A frame with no recorded dimensions yields null rather
 * than a guess: the caller then omits the box, and the reader sees an uncropped
 * photograph instead of a crop of the wrong region.
 */
export function faceBox(
  bbox: number[], width: number | null, height: number | null,
): FaceBox | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const [x, y, w, h] = bbox;
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return null;
  const unit = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x: unit(x / width), y: unit(y / height),
    w: unit(w / width), h: unit(h / height),
  };
}

/**
 * Does this pixel box actually belong to a frame of these dimensions?
 *
 * The check that was missing. A box measured in a 3200px space against a frame
 * recorded as 7008px passes every type check and every range check ever written —
 * it is simply in the wrong coordinate system, and the only evidence is that it
 * sits implausibly far inside the frame. That cannot be caught per box.
 *
 * What CAN be caught, exactly and per box, is the other direction: a box that
 * does not FIT. The 2026-08-09 divergence produced both populations from one
 * cause — photos indexed as 'thumb' with original dimensions gave small boxes,
 * and the same source toggled the other way gave boxes running past the frame
 * edge. Rejecting the overflow half stops the writer that produces both.
 *
 * TOLERANCE is 25% of the long edge, and it is wide on purpose — measured, not
 * guessed. SCRFD predicts the WHOLE face box even when the frame cuts through it,
 * so a runner at the bottom edge legitimately produces a box that ends past it.
 * In production (Angkor, 27,988 photos with faces) every such case overshot by
 * 3.7% to 6.6% of the long edge; eight photos in all.
 *
 * A coordinate-space mismatch is not in that league. Boxes measured in a 6224px
 * frame against dimensions of 3200 overshoot by 95%. The two populations are two
 * orders of magnitude apart, so one threshold separates them cleanly, and 25%
 * sits far above the honest overshoot and far below the mismatch.
 *
 * Getting this wrong in the tight direction is expensive: the check runs during
 * indexing, and rejecting a batch fails the pass. A 2% tolerance — which looked
 * reasonable and was the first thing written here — would have killed a
 * 27,000-photo album over eight faces standing near the edge of a frame.
 */
export const BBOX_TOLERANCE = 0.25;

export function bboxFitsFrame(
  bbox: number[], width: number | null, height: number | null,
): boolean {
  // Nothing to contradict: a photo with no dimensions cannot be checked, and
  // refusing the write would block an album over a missing EXIF field.
  if (!width || !height || width <= 0 || height <= 0) return true;
  const [x, y, w, h] = bbox;
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return false;
  if (w <= 0 || h <= 0) return false;
  const slack = Math.max(width, height) * BBOX_TOLERANCE;
  return x >= -slack && y >= -slack
      && x + w <= width + slack
      && y + h <= height + slack;
}
