-- The pass queue lives on the jobs table.
--
--     npx wrangler d1 execute race-lens --local  \
--       --file=./migrations/014_jobs_queue.sql
--     npx wrangler d1 execute race-lens --remote \
--       --file=./migrations/014_jobs_queue.sql
--
-- Until now every start-a-pass control dispatched a GitHub workflow immediately
-- and the only queue was GitHub's own `concurrency` group, which is per EVENT —
-- so passes on two albums competed for the same Google Drive quota, a bib re-read
-- on a five-link album fired five dispatches at once, and nothing in this
-- database could show, reorder or cancel any of it.
--
-- Two columns turn the rows that already exist into that queue:
--
--   payload       what the workflow needs beyond the ids — folder, image_source,
--                 and the bibs_only / no_resume / rebuild flags. It has to be
--                 stored because the dispatch now happens LATER, from drain(),
--                 not in the request that created the row. JSON rather than a
--                 column each: the set of flags has grown twice already.
--
--   dispatched_at NULL means "waiting in our queue". That is the whole state
--                 machine. It is also what starts the staleness clock — a job
--                 waiting its turn is not late, and must never be written off as
--                 stale, which counting from updated_at alone would do.
--
-- Every EXISTING row is marked as already dispatched. They were: their workflows
-- were fired the moment they were created, and leaving dispatched_at NULL would
-- have the first drain re-dispatch historic jobs — including finished ones, whose
-- status is not 'queued' but which would still be picked up by a looser query
-- than the one in queue.ts. This is a one-way door, so it is deliberate and
-- explicit rather than left to a default.

ALTER TABLE jobs ADD COLUMN payload TEXT;
ALTER TABLE jobs ADD COLUMN dispatched_at TEXT;

UPDATE jobs SET dispatched_at = updated_at WHERE dispatched_at IS NULL;

-- The drain query: undispatched, queued, oldest first.
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(dispatched_at, status, updated_at);
