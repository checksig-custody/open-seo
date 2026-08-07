-- Postgres mirror of `0049_ledger_cost_centre` (see the D1 migration for why).
--
-- Three cost centres share `search_usage_ledger` and the budget authority read
-- the whole table under one name, so ranking and keyword-volume spend was
-- reported against Domain Overview. The fix labels the rows and splits the
-- READ, which keeps the global total invariant by construction rather than by
-- moving money between tables.
--
-- The backfill is a label derived from `endpoint_path`, the correlation the
-- rows already carry — not an estimate. Additive and forward-only.
ALTER TABLE "search_usage_ledger" ADD COLUMN IF NOT EXISTS "cost_centre" text;--> statement-breakpoint

UPDATE "search_usage_ledger"
   SET "cost_centre" = 'ranking'
 WHERE "cost_centre" IS NULL
   AND "endpoint_path" LIKE '%serp/google/organic/%';--> statement-breakpoint

UPDATE "search_usage_ledger"
   SET "cost_centre" = 'keyword_volume'
 WHERE "cost_centre" IS NULL
   AND "endpoint_path" LIKE '%keyword_overview%';--> statement-breakpoint

UPDATE "search_usage_ledger"
   SET "cost_centre" = 'domain_overview'
 WHERE "cost_centre" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "search_usage_ledger_cost_centre_idx" ON "search_usage_ledger" ("day","cost_centre");
