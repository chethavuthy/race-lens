-- Race Lens — D1 schema
-- Apply with:  wrangler d1 execute race-lens --file=./schema.sql --remote

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,               -- nanoid
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  event_date   TEXT,                           -- ISO date (YYYY-MM-DD)
  banner_key   TEXT,                           -- R2 key
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft|indexing|ready|partial
  photo_count  INTEGER NOT NULL DEFAULT 0,
  face_count   INTEGER NOT NULL DEFAULT 0,
  -- 0 for events that hand out no bibs at all (fun runs, community runs).
  -- Turns off bib OCR during indexing and bib search on the event page; face
  -- search is unaffected. Defaults to 1 so existing events keep their behaviour.
  bibs_enabled INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

-- One event can absorb several Drive folders from different photographers.
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id),
  drive_folder_id TEXT NOT NULL,
  drive_url       TEXT NOT NULL,
  discovered      INTEGER NOT NULL DEFAULT 0,  -- images the walk found in this folder
  -- 'original' downloads the full-size file; 'thumb' uses Drive's resized
  -- endpoint (~12x smaller, so ~12x more photos per Drive download quota).
  -- Chosen per source by the organizer, after benchmarking that folder.
  image_source    TEXT NOT NULL DEFAULT 'original',
  added_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_event ON sources(event_id);
-- Required, not merely useful: POST /api/admin/ingest upserts with
-- ON CONFLICT (event_id, drive_folder_id), and SQLite refuses to PREPARE a
-- conflict target that has no matching unique constraint. Without this the only
-- route that binds a folder to an event throws before touching the database.
--
-- On a database that predates this line, run migrations/002_schema_repair.sql
-- first — it merges the duplicate sources that the pre-upsert code created, which
-- this index cannot be built over.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_event_folder
  ON sources(event_id, drive_folder_id);

CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id),
  source_id     TEXT NOT NULL REFERENCES sources(id),
  drive_file_id TEXT NOT NULL,
  thumb_key     TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  taken_at      TEXT,
  -- 1 once this photo's face vectors are durable in an R2 shard.
  --
  -- The resume key, and deliberately not "a photo row exists": rows are committed
  -- at the start of a batch and vectors flush at the end, so an interruption in
  -- between leaves photos that exist with no faces. Resuming on existence skipped
  -- those forever while finalize still called the event 'ready'.
  --
  -- DEFAULT 1 is for the migration, not for new rows — POST /events/:id/photos
  -- always inserts 0 explicitly and the runner flips it to 1 after the shard
  -- lands. On an existing database a default of 0 would mark every photo
  -- unfinished and trigger a full re-download.
  faces_done    INTEGER NOT NULL DEFAULT 1,
  -- Deliberately (event_id, drive_file_id) rather than a global unique on
  -- drive_file_id: the same Drive file can legitimately appear in two events
  -- (e.g. a combined 5k/10k album). Dedupe is per event, which is all the
  -- idempotent-rerun guarantee actually needs.
  UNIQUE (event_id, drive_file_id)
);
CREATE INDEX IF NOT EXISTS idx_photos_event ON photos(event_id, id);
-- The admin report counts photos per source on every poll, and /finalize compares
-- discovered against it per source. Without this, both full-scan photos once per
-- link.
CREATE INDEX IF NOT EXISTS idx_photos_source ON photos(source_id);

CREATE TABLE IF NOT EXISTS bibs (
  event_id TEXT NOT NULL,
  bib      TEXT NOT NULL,
  photo_id TEXT NOT NULL REFERENCES photos(id),
  conf     REAL,
  bib_raw  TEXT,                          -- exactly as printed, e.g. "0056"
  -- 'ocr' or 'manual'. A re-read only ever clears 'ocr' rows, so an organizer's
  -- correction is never erased by re-indexing.
  source   TEXT NOT NULL DEFAULT 'ocr',
  PRIMARY KEY (event_id, bib, photo_id)
);
CREATE INDEX IF NOT EXISTS idx_bibs_lookup ON bibs(event_id, bib);
-- The primary key above starts (event_id, bib), so photo_id is its third column
-- and cannot serve a lookup. Every photo -> bibs query — the admin photo filters,
-- the per-photo delete, and the batch replace on the indexing hot path — scanned
-- the whole table without this.
CREATE INDEX IF NOT EXISTS idx_bibs_photo ON bibs(photo_id);

-- Tombstones for OCR reads the organizer deleted by hand.
--
-- Deleting a wrong bib is not enough on its own: the next re-index reads it again
-- and puts it straight back, so the correction looks undone. POST
-- /api/internal/events/:id/bibs filters every incoming (photo, bib) pair against
-- this table, which means it is read on EVERY bib-writing batch — an absent table
-- fails the whole indexing pass, not one endpoint.
--
-- The primary key must stay exactly (event_id, photo_id, bib): admin.ts names that
-- tuple as an ON CONFLICT target.
CREATE TABLE IF NOT EXISTS bib_rejects (
  event_id   TEXT NOT NULL,
  photo_id   TEXT NOT NULL REFERENCES photos(id),
  bib        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, photo_id, bib)
);

-- Vector rows live in R2 shards; this table maps global row index -> photo.
CREATE TABLE IF NOT EXISTS faces (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL,
  photo_id  TEXT NOT NULL REFERENCES photos(id),
  row_idx   INTEGER NOT NULL,                  -- global index within the event
  bbox      TEXT NOT NULL,                     -- JSON [x,y,w,h]
  bib       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_faces_event_row ON faces(event_id, row_idx);
-- Search joins by row_idx, but everything else looks a photo up by id: the admin
-- photo filters, the per-photo re-index delete, and the resume key for --rebuild.
-- That last one runs EXISTS(...) once per photo, so on a 78k-face event it was
-- ~2.4 billion row reads and could not complete.
CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);
-- Lets the report's COUNT(DISTINCT photo_id) per event stay inside the index.
CREATE INDEX IF NOT EXISTS idx_faces_event_photo ON faces(event_id, photo_id);

CREATE TABLE IF NOT EXISTS face_shards (
  event_id   TEXT NOT NULL,
  shard_key  TEXT NOT NULL,                    -- R2 key
  row_base   INTEGER NOT NULL,                 -- global row_idx of this shard's row 0
  row_count  INTEGER NOT NULL,
  PRIMARY KEY (event_id, shard_key)
);

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  source_id  TEXT,
  status     TEXT NOT NULL,                    -- queued|running|done|partial|failed
  done       INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  -- How many times this job has auto-continued after a Drive rate limit.
  -- Bounds the chain so a permanently-failing folder cannot loop forever.
  attempts   INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,       -- photos this job could not fetch
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_event ON jobs(event_id, updated_at);

-- Per-event ingest journal. The organizer pastes a link and walks away; when
-- an album comes back short they need to know which link, how many photos, and
-- why — without reading CI logs they have no access to.
-- One-off quality comparison for a folder: same photos, thumbnail vs original.
-- Deliberately on demand, never automatic — it costs a CI run.
CREATE TABLE IF NOT EXISTS benchmarks (
  id          TEXT PRIMARY KEY,
  folder_id   TEXT NOT NULL,
  status      TEXT NOT NULL,            -- queued|running|done|failed
  sample      INTEGER NOT NULL DEFAULT 6,
  result      TEXT,                     -- JSON written by the runner
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL,
  job_id        TEXT,
  source_id     TEXT,
  level         TEXT NOT NULL,          -- info|warn|error
  code          TEXT,                   -- quota|download_failed|decode_failed|…
  message       TEXT NOT NULL,
  drive_file_id TEXT,                   -- set when the entry is about one photo
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_log_event ON ingest_log(event_id, id DESC);
