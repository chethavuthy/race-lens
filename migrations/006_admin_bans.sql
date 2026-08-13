-- admin_bans — take someone's access away from inside the app.
--
--   npx wrangler d1 execute race-lens --local  --config apps/api/wrangler.toml \
--     --file=./migrations/006_admin_bans.sql
--   npx wrangler d1 execute race-lens --remote --config apps/api/wrangler.toml \
--     --file=./migrations/006_admin_bans.sql
--
-- WHY, WHEN CLOUDFLARE ACCESS ALREADY HAS AN ALLOWLIST
--
-- Removing an email from the Access policy stops the person signing in, and does
-- nothing else: their events stay published on the public site, and the act
-- happens in a dashboard where nothing in this repo can see it, test it, or show
-- it. This table is the same decision made where the rest of the product can act
-- on it — the API refuses them, and banning can unpublish what they put up in
-- the same breath.
--
-- It is NOT a replacement for the Access policy. A ban here refuses every admin
-- route; taking the email off the Access list is still what stops them holding a
-- valid session at all. Do both — the app-side ban is the one that cleans up.
--
-- Emails are stored lowercased, because that is how they are compared: an Access
-- identity is not case-sensitive and a ban that Sok@x.com walked around would be
-- worse than no ban.
CREATE TABLE IF NOT EXISTS admin_bans (
  email     TEXT PRIMARY KEY,
  reason    TEXT,
  banned_at TEXT NOT NULL
);
