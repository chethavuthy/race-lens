-- organizers — who may use the admin, decided here instead of in a dashboard.
--
--   npx wrangler d1 execute race-lens --local  --config apps/api/wrangler.toml \
--     --file=./migrations/007_organizers.sql
--   npx wrangler d1 execute race-lens --remote --config apps/api/wrangler.toml \
--     --file=./migrations/007_organizers.sql
--
-- WHAT CHANGES
--
-- Cloudflare Access stops being the guest list and becomes what it is good at:
-- proving that whoever is knocking owns the email they claim. Its policy allows
-- any verified address; this table decides which of those addresses is an
-- organizer. Adding a photographer becomes a field on /admin — the operator
-- reads a Telegram message and types the address — rather than two policy edits
-- in a dashboard, which is the workflow the invitation on /admin promises.
--
-- WHAT THAT COSTS, STATED PLAINLY
--
-- A stranger can now authenticate and reach the Worker, where before Access
-- turned them away first. Every admin route is behind one middleware that looks
-- them up here and refuses anything it does not find, so an unknown caller gets
-- the same 403 as a banned one and the page shows them the invitation. That
-- check is now load-bearing: it must fail closed on every uncertainty, and it
-- does — no row means no.
--
-- WHY IT ABSORBS admin_bans RATHER THAN SITTING BESIDE IT
--
-- "Allowed" and "banned" are one axis, not two. Two tables would let a row exist
-- in both, and then the answer to "may this person in?" depends on which table
-- you read first. `banned_at` on the single row cannot contradict itself.
CREATE TABLE IF NOT EXISTS organizers (
  email     TEXT PRIMARY KEY,          -- lowercased; Access identities are not case-sensitive
  added_at  TEXT NOT NULL,
  added_by  TEXT,                      -- who let them in, for when it is not obvious later
  -- Set when access was withdrawn. The row stays: it is the record that this
  -- person was here, and the only place an unban can be undone from.
  banned_at TEXT,
  reason    TEXT
);

-- Carry over anything already banned, so a withdrawal is not silently reversed
-- by this migration. Banned-but-never-invited is a real state: they are listed,
-- and refused.
INSERT OR IGNORE INTO organizers (email, added_at, added_by, banned_at, reason)
  SELECT email, banned_at, NULL, banned_at, reason FROM admin_bans;

DROP TABLE IF EXISTS admin_bans;
