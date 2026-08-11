#!/usr/bin/env node
/**
 * Are the stored face boxes in the same coordinate space as the frames they
 * belong to? Answered per event, over the whole table, in one command.
 *
 *   node tools/audit-bbox.mjs            # remote D1 (production)
 *   node tools/audit-bbox.mjs --local    # the local dev database
 *
 * WHY THIS EXISTS
 *
 * faces.bbox is measured in the pixels of the array the detector ran on, and
 * photos.width/height are supposed to record that same array. On 2026-08-09 they
 * diverged: the indexer detected on Drive's w3200 copy while storing Drive's
 * numbers for the 6000px original. Every box came out ~2.2x too small and pulled
 * toward the top-left corner — and nothing anywhere failed. The fractions stayed
 * inside 0..1, the admin overlay drew them faithfully, and the tile caption still
 * read "cropped to you". It was found by a person looking at a screenshot two days
 * later, and proving it took ad-hoc SQL over the whole table.
 *
 * That diagnosis is what this script is. It reports both halves of the problem:
 *
 *   OVERFLOW  a box that cannot belong to its frame — off by 25% of the long edge
 *             or more, the same condition the Worker rejects at ingest
 *             (bboxFitsFrame). Any count above zero is stale data written before
 *             that guard existed.
 *
 *   AT EDGE   boxes overshooting by more than 2% but nowhere near 25%. The HONEST
 *             population: SCRFD predicts the whole face box for a runner the frame
 *             cuts through. Informational only — the first version of this script
 *             called these failures, which would have condemned eight perfectly
 *             good photos in Angkor and, worse, failed the pass that wrote them.
 *
 *   REACH     of the frames with several faces, how far across the frame the
 *             furthest one sits, averaged. This is the SHRINK direction, which no
 *             per-box check can catch: a box measured in a smaller space still
 *             fits. It cannot be an assertion, only a signal — a healthy album
 *             sits near 0.75, because a group shot spans most of the frame.
 *             KAIIA RUPP read 0.52 while Angkor read 0.77.
 *
 * Neither number is a verdict on its own. Together they are the difference
 * between "somebody eyeballs an overlay" and "a check anyone can re-run".
 */
import { execFileSync } from 'node:child_process';

const local = process.argv.includes('--local');

const SQL = `
WITH per_photo AS (
  SELECT
    p.event_id                                                  AS event_id,
    p.id                                                        AS photo_id,
    p.width                                                     AS w,
    p.height                                                    AS h,
    COUNT(f.id)                                                 AS faces,
    MAX(p.width, p.height)                                      AS long_edge,
    MAX(CAST(json_extract(f.bbox,'$[0]') AS REAL)
        + CAST(json_extract(f.bbox,'$[2]') AS REAL))             AS max_right,
    MAX(CAST(json_extract(f.bbox,'$[1]') AS REAL)
        + CAST(json_extract(f.bbox,'$[3]') AS REAL))             AS max_bottom
  FROM photos p JOIN faces f ON f.photo_id = p.id
  GROUP BY p.id
)
SELECT
  e.slug                                                        AS event,
  COUNT(*)                                                      AS photos_with_faces,
  -- 0.25 matches BBOX_TOLERANCE in apps/api/src/bbox.ts, and is wide for a
  -- measured reason: SCRFD predicts the whole box for a face the frame cuts
  -- through, so a runner at the edge honestly overshoots by up to ~7% of the long
  -- edge. A space mismatch overshoots by ~95%. Flagging the honest ones would make
  -- this script cry wolf on every album.
  SUM(CASE WHEN pp.w > 0 AND pp.h > 0
            AND (pp.max_right  > pp.w + pp.long_edge * 0.25
              OR pp.max_bottom > pp.h + pp.long_edge * 0.25)
           THEN 1 ELSE 0 END)                                    AS overflowing,
  -- Reported separately, never as a failure: this is the honest-overshoot
  -- population, and it is only here so a sudden jump in it is visible.
  SUM(CASE WHEN pp.w > 0 AND pp.h > 0
            AND (pp.max_right  > pp.w + pp.long_edge * 0.02
              OR pp.max_bottom > pp.h + pp.long_edge * 0.02)
           THEN 1 ELSE 0 END)                                    AS edge_faces,
  SUM(CASE WHEN pp.w IS NULL OR pp.h IS NULL OR pp.w = 0 OR pp.h = 0
           THEN 1 ELSE 0 END)                                    AS unmeasurable,
  ROUND(AVG(CASE WHEN pp.faces >= 5 AND pp.long_edge > 4000
                 THEN pp.max_right * 1.0 / pp.w END), 3)         AS reach_big_frames,
  SUM(CASE WHEN pp.faces >= 5 AND pp.long_edge > 4000 THEN 1 ELSE 0 END) AS big_frames
FROM per_photo pp JOIN events e ON e.id = pp.event_id
GROUP BY pp.event_id
ORDER BY photos_with_faces DESC;
`.trim();

const out = execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'race-lens',
  local ? '--local' : '--remote',
  '--config', 'apps/api/wrangler.toml',
  '--json', '--command', SQL,
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

// wrangler prints its update banner on stdout ahead of the JSON.
const rows = JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];

if (!rows.length) {
  console.log('No events with face rows.');
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s ?? '—').padStart(n);

console.log(`\nFace-box audit — ${local ? 'local' : 'REMOTE (production)'}\n`);
console.log(`  ${pad('event', 40)} ${num('photos', 7)} ${num('overflow', 9)} ${num('at edge', 8)} ${num('no dims', 8)} ${num('reach', 6)}`);
console.log(`  ${'-'.repeat(40)} ${'-'.repeat(7)} ${'-'.repeat(9)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(6)}`);

let bad = 0;
const suspect = [];
for (const r of rows) {
  if (r.overflowing > 0) bad += r.overflowing;
  // A sample too small to average tells us nothing either way, so it is not
  // reported as suspicious — silence beats a false alarm on a 30-photo album.
  if (r.big_frames >= 20 && r.reach_big_frames !== null && r.reach_big_frames < 0.62) {
    suspect.push(r);
  }
  console.log(`  ${pad(r.event, 40)} ${num(r.photos_with_faces, 7)} ${num(r.overflowing, 9)} ${num(r.edge_faces, 8)} ${num(r.unmeasurable, 8)} ${num(r.reach_big_frames, 6)}`);
}

console.log('');
if (bad) {
  console.log(`FAIL  ${bad} photo(s) hold a face box that does not fit their frame.`);
  console.log('      These predate the ingest guard. Re-index the affected sources with');
  console.log('      --rebuild so both halves are written by current code.');
}
for (const r of suspect) {
  console.log(`WARN  ${r.event}: faces reach only ${r.reach_big_frames} of the frame across`);
  console.log(`      ${r.big_frames} crowded frames. A healthy album sits near 0.75 — this is`);
  console.log('      the signature of boxes measured in a SMALLER space than the frame.');
}
if (!bad && !suspect.length) console.log('ok    Every event\'s boxes fit their frames, and reach looks normal.');

process.exit(bad ? 1 : 0);
