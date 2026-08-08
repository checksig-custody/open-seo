-- Postgres mirror of `0051_site_audit_source` (see the D1 migration).
--
-- Readiness counted site-audit runs with `1 = 1` — the only fact in that file
-- with no provenance filter — so a queued, running or failed run satisfied the
-- gate. There was no column to filter on. `first_party_crawl` is the honest
-- value: Site Audit crawls the entity's own pages and buys nothing.
-- Additive and forward-only.
ALTER TABLE "si_site_audit_runs" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint

UPDATE "si_site_audit_runs"
   SET "source" = 'first_party_crawl'
 WHERE "source" IS NULL;
