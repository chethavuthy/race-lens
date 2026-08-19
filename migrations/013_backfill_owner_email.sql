-- Give the pre-ownership events an owner.
--
--     npx wrangler d1 execute race-lens --local  \
--       --file=./migrations/013_backfill_owner_email.sql
--     npx wrangler d1 execute race-lens --remote \
--       --file=./migrations/013_backfill_owner_email.sql
--
-- migrations/005 added events.owner_email and left every existing row NULL,
-- documenting that NULL means "the operator's, from before this was recorded".
-- That was true and it was cheap, but it left the fact in a comment instead of in
-- the column, and three screens then had to agree about how to read it:
--
--   * /admin printed "published by you" for the NULL rows and "published by
--     <the operator's own address>" for the one row that recorded them — the same
--     person, labelled two ways in one list.
--   * "Who can publish" counts per owner_email, so the operator showed as
--     "1 event · 1 live · 1,070 photos" while owning four albums and 35,000+
--     photos.
--   * Nothing could group the list by owner without re-deriving the assumption.
--
-- Writing it down once fixes all three. OWNER_EMAIL in apps/api/wrangler.toml is
-- the operator, and it is a deploy-time constant, so it is safe to inline here —
-- if it is ever changed, this migration is already spent and must not be re-run
-- against the new address.
--
-- Scoped to NULL and '' only. A row that names another photographer is their
-- record of publishing it, and nothing here reassigns ownership: the API has no
-- route that does either, deliberately.

UPDATE events
   SET owner_email = 'vuthychetha@gmail.com'
 WHERE owner_email IS NULL OR TRIM(owner_email) = '';
