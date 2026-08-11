-- Schema repair: two objects the code has always depended on and schema.sql never
-- created, plus the indexes its own query shapes require.
--
--   npx wrangler d1 execute race-lens --local  --config apps/api/wrangler.toml \
--     --file=./migrations/002_schema_repair.sql
--   npx wrangler d1 execute race-lens --remote --config apps/api/wrangler.toml \
--     --file=./migrations/002_schema_repair.sql
--
-- Idempotent: every statement is IF NOT EXISTS or a no-op on an already-repaired
-- database. Verified by applying schema.sql to sqlite3 and then this file, both on
-- a clean database and on one seeded with duplicate sources and pre-orphaned rows.
--
-- WHY A MIGRATION AND NOT JUST schema.sql: schema.sql is CREATE TABLE IF NOT
-- EXISTS throughout, which is idempotent for NEW tables but cannot add an index to
-- a table that already exists with conflicting rows. The live database needs the
-- duplicate merge below before the unique index can be created at all.

-- 1. bib_rejects --------------------------------------------------------------
-- Referenced by admin.ts (INSERT tombstone on bib delete, DELETE on manual
-- assign) and by internal.ts, which SELECTs it on EVERY bib-writing batch. So on
-- a database built from schema.sql alone, indexing any bib-bearing event 500s and
-- the runner fails the whole job after five retries. `git log -S bib_rejects --
-- schema.sql` returns nothing: this DDL was never committed.
--
-- The PRIMARY KEY must be exactly (event_id, photo_id, bib). admin.ts names that
-- tuple as an ON CONFLICT target, and SQLite refuses to PREPARE a conflict target
-- with no matching unique constraint — the same failure as (2) below.
CREATE TABLE IF NOT EXISTS bib_rejects (
  event_id   TEXT NOT NULL,
  photo_id   TEXT NOT NULL REFERENCES photos(id),
  bib        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, photo_id, bib)
);

-- 2. UNIQUE (event_id, drive_folder_id) on sources ----------------------------
-- POST /api/admin/ingest upserts with ON CONFLICT (event_id, drive_folder_id).
-- Without a matching unique index SQLite will not prepare the statement, so the
-- only route that binds a Drive folder to an event throws before touching the DB.

-- 2a. Preserve a 'thumb' choice BEFORE collapsing duplicates.
-- The keeper below is MIN(id), which is arbitrary — it can easily be the row still
-- set to 'original'. Losing 'thumb' sends the next pass back to full-size
-- downloads and the Drive quota wall that made the organizer change it, which is
-- the exact regression af69ad3 was written to fix. So promote first, collapse after.
UPDATE sources SET image_source = 'thumb'
 WHERE image_source <> 'thumb'
   AND EXISTS (SELECT 1 FROM sources d
                WHERE d.event_id        = sources.event_id
                  AND d.drive_folder_id = sources.drive_folder_id
                  AND d.image_source    = 'thumb');

-- 2b. Repoint EVERY table carrying a source id at the keeper, not just photos.
-- jobs.source_id and ingest_log.source_id have no declared foreign key, so an
-- orphan raises no error — it just silently drops those passes out of the report
-- join at admin.ts:288. The production merge in 3c7ac9c repointed all three
-- ("photos, jobs and log entries"); this reproduces that for every other database.
--
-- The EXISTS guard matters: photos.source_id is NOT NULL, so on a database that
-- is ALREADY orphaned the bare subquery would evaluate to NULL and abort the
-- migration on a constraint violation.
UPDATE photos SET source_id = (
  SELECT MIN(s2.id) FROM sources s2
   WHERE s2.event_id        = (SELECT s1.event_id        FROM sources s1 WHERE s1.id = photos.source_id)
     AND s2.drive_folder_id = (SELECT s1.drive_folder_id FROM sources s1 WHERE s1.id = photos.source_id)
) WHERE EXISTS (SELECT 1 FROM sources s WHERE s.id = photos.source_id);

UPDATE jobs SET source_id = (
  SELECT MIN(s2.id) FROM sources s2
   WHERE s2.event_id        = (SELECT s1.event_id        FROM sources s1 WHERE s1.id = jobs.source_id)
     AND s2.drive_folder_id = (SELECT s1.drive_folder_id FROM sources s1 WHERE s1.id = jobs.source_id)
) WHERE source_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM sources s WHERE s.id = jobs.source_id);

UPDATE ingest_log SET source_id = (
  SELECT MIN(s2.id) FROM sources s2
   WHERE s2.event_id        = (SELECT s1.event_id        FROM sources s1 WHERE s1.id = ingest_log.source_id)
     AND s2.drive_folder_id = (SELECT s1.drive_folder_id FROM sources s1 WHERE s1.id = ingest_log.source_id)
) WHERE source_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM sources s WHERE s.id = ingest_log.source_id);

-- 2c. Collapse, then enforce.
DELETE FROM sources WHERE id NOT IN (
  SELECT MIN(id) FROM sources GROUP BY event_id, drive_folder_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_event_folder
  ON sources(event_id, drive_folder_id);

-- 3. Indexes for the query shapes actually issued -----------------------------
-- bibs' primary key is (event_id, bib, photo_id), so photo_id is the THIRD column
-- and unusable as a lookup prefix; faces has only (event_id, row_idx); photos has
-- nothing on source_id. Every photo->faces and photo->bibs lookup therefore
-- scanned the whole table. Confirmed with EXPLAIN QUERY PLAN before and after:
--
--   admin filter=no_face      SCAN f  ->  SEARCH f USING COVERING INDEX idx_faces_photo
--   DELETE bibs by photo_id   SCAN bibs -> SEARCH bibs USING INDEX idx_bibs_photo
--   report COUNT per source   SCAN p  ->  SEARCH p USING COVERING INDEX idx_photos_source
--
-- The worst case was GET /events/:id/indexed?complete=1, which runs
-- EXISTS (SELECT 1 FROM faces WHERE photo_id = p.id) once per photo: on a
-- 31k-photo / 78k-face event that is ~2.4 billion row reads, so --rebuild could
-- never finish.
CREATE INDEX IF NOT EXISTS idx_faces_photo   ON faces(photo_id);
CREATE INDEX IF NOT EXISTS idx_bibs_photo    ON bibs(photo_id);
CREATE INDEX IF NOT EXISTS idx_photos_source ON photos(source_id);
-- Makes the report's COUNT(DISTINCT photo_id) FROM faces index-only rather than a
-- rowid lookup per face row.
CREATE INDEX IF NOT EXISTS idx_faces_event_photo ON faces(event_id, photo_id);
