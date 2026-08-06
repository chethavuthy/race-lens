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
  created_at   TEXT NOT NULL
);

-- One event can absorb several Drive folders from different photographers.
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id),
  drive_folder_id TEXT NOT NULL,
  drive_url       TEXT NOT NULL,
  discovered      INTEGER NOT NULL DEFAULT 0,  -- images the walk found in this folder
  added_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_event ON sources(event_id);

CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id),
  source_id     TEXT NOT NULL REFERENCES sources(id),
  drive_file_id TEXT NOT NULL,
  thumb_key     TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  taken_at      TEXT,
  -- Deliberately (event_id, drive_file_id) rather than a global unique on
  -- drive_file_id: the same Drive file can legitimately appear in two events
  -- (e.g. a combined 5k/10k album). Dedupe is per event, which is all the
  -- idempotent-rerun guarantee actually needs.
  UNIQUE (event_id, drive_file_id)
);
CREATE INDEX IF NOT EXISTS idx_photos_event ON photos(event_id, id);

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
