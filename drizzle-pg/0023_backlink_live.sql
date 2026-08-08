-- Phase 3 live backlinks: what a fixture snapshot never had to say.
--
-- The phase-3 tables were built against a deterministic fixture provider, which
-- always answers completely and costs nothing. A real provider does neither: it
-- answers about a SAMPLE of a much larger index, sometimes partially, sometimes
-- not at all, and it charges. Every column below exists so a reader can tell
-- those cases apart instead of reading a truncated sample as a whole profile.
--
-- Additive throughout: no table is dropped, no column is rewritten.

-- `provider` already says which implementation ran. `source` says whether the
-- DATA is a measurement, which is the question a SQL check or an export needs
-- to answer without knowing the code.
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'fixture' NOT NULL;--> statement-breakpoint
-- `complete` / `partial` / `no_data`: a provider that answered and knows nothing
-- is not a provider that answered halfway, and neither is an error.
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "snapshot_status" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "snapshot_status_reason" text;--> statement-breakpoint

-- THE SAMPLE, STATED. A backlink absent from 100 sampled rows of a 10,000-row
-- profile has not been lost; it has not been looked at. These four columns are
-- what makes that distinction available to every consumer, and they are why a
-- comparison can refuse to call anything lost.
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "sample_limit" integer;--> statement-breakpoint
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "sample_offset" integer;--> statement-breakpoint
-- Rows sampled / rows the provider says exist. Null when the provider does not
-- report a total, because a coverage figure invented from a sample is worse
-- than none.
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "dataset_coverage" real;--> statement-breakpoint
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "reported_backlink_total" integer;--> statement-breakpoint
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "reported_referring_domain_total" integer;--> statement-breakpoint
-- The request shape, so two snapshots are only ever compared when they asked
-- the same question of the same index.
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "dataset_signature" text;--> statement-breakpoint

-- Money and provenance on the row that reports the profile.
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "cost_status" text;--> statement-breakpoint
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "provider_reported_cost_micros" integer;--> statement-breakpoint
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "job_id" text;--> statement-breakpoint
ALTER TABLE "si_backlink_snapshots" ADD COLUMN IF NOT EXISTS "operation_id" text;--> statement-breakpoint

-- The ledger learns the same vocabulary as phase 1 and 2, so one accounting
-- object can feed the job, the ledger and the snapshot without translation.
ALTER TABLE "si_backlink_usage_ledger" ADD COLUMN IF NOT EXISTS "cost_status" text;--> statement-breakpoint
ALTER TABLE "si_backlink_usage_ledger" ADD COLUMN IF NOT EXISTS "provider_reported_cost_micros" integer;--> statement-breakpoint
ALTER TABLE "si_backlink_usage_ledger" ADD COLUMN IF NOT EXISTS "free_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "si_backlink_usage_ledger" ADD COLUMN IF NOT EXISTS "job_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "si_backlink_usage_ledger" ADD COLUMN IF NOT EXISTS "operation_id" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- A job that spent money should be able to say how much without a join through
-- a timestamp, which is the mistake phase 1 had to migrate its way out of.
ALTER TABLE "si_backlink_jobs" ADD COLUMN IF NOT EXISTS "operation_id" text;--> statement-breakpoint
ALTER TABLE "si_backlink_jobs" ADD COLUMN IF NOT EXISTS "actual_cost_micros" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "si_backlink_jobs" ADD COLUMN IF NOT EXISTS "cost_status" text;--> statement-breakpoint
ALTER TABLE "si_backlink_jobs" ADD COLUMN IF NOT EXISTS "error_origin" text;--> statement-breakpoint
ALTER TABLE "si_backlink_jobs" ADD COLUMN IF NOT EXISTS "error_class" text;--> statement-breakpoint
ALTER TABLE "si_backlink_jobs" ADD COLUMN IF NOT EXISTS "error_code" text;--> statement-breakpoint
ALTER TABLE "si_backlink_jobs" ADD COLUMN IF NOT EXISTS "endpoint" text;--> statement-breakpoint

-- Referring domains and backlinks carry the sampling context of the snapshot
-- they came from, so a row read on its own still knows it came from a sample.
ALTER TABLE "si_referring_domains" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'fixture' NOT NULL;--> statement-breakpoint
ALTER TABLE "si_referring_domains" ADD COLUMN IF NOT EXISTS "referring_main_domain" text;--> statement-breakpoint
ALTER TABLE "si_referring_domains" ADD COLUMN IF NOT EXISTS "dofollow_count" integer;--> statement-breakpoint
ALTER TABLE "si_referring_domains" ADD COLUMN IF NOT EXISTS "nofollow_count" integer;--> statement-breakpoint
ALTER TABLE "si_referring_domains" ADD COLUMN IF NOT EXISTS "language" text;--> statement-breakpoint

ALTER TABLE "si_backlinks" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'fixture' NOT NULL;--> statement-breakpoint
ALTER TABLE "si_backlinks" ADD COLUMN IF NOT EXISTS "source_main_domain" text;--> statement-breakpoint
ALTER TABLE "si_backlinks" ADD COLUMN IF NOT EXISTS "target_domain" text;--> statement-breakpoint
ALTER TABLE "si_backlinks" ADD COLUMN IF NOT EXISTS "backlink_type" text;--> statement-breakpoint
ALTER TABLE "si_backlinks" ADD COLUMN IF NOT EXISTS "is_broken" integer;--> statement-breakpoint
ALTER TABLE "si_backlinks" ADD COLUMN IF NOT EXISTS "language" text;--> statement-breakpoint
ALTER TABLE "si_backlinks" ADD COLUMN IF NOT EXISTS "snapshot_id" text;--> statement-breakpoint

-- `referring_domain_count` already exists — one sitewide footer link and a
-- genuine pattern were always distinguishable. What was missing is the follow
-- split and the share, which is what makes a distribution a distribution.
ALTER TABLE "si_anchor_snapshots" ADD COLUMN IF NOT EXISTS "dofollow_count" integer;--> statement-breakpoint
ALTER TABLE "si_anchor_snapshots" ADD COLUMN IF NOT EXISTS "nofollow_count" integer;--> statement-breakpoint
-- Share of the sampled backlinks. Null rather than 0 when the denominator is
-- unknown, and computed over the SAMPLE, which is why the snapshot carries its
-- sample limit. `category` already distinguishes empty / generic / url anchors,
-- and an empty anchor keeps its empty text rather than an invented string.
ALTER TABLE "si_anchor_snapshots" ADD COLUMN IF NOT EXISTS "share_percent" real;--> statement-breakpoint

-- The gap says what it could and could not see.
ALTER TABLE "si_backlink_gap_snapshots" ADD COLUMN IF NOT EXISTS "dataset_coverage" real;--> statement-breakpoint
ALTER TABLE "si_backlink_gap_snapshots" ADD COLUMN IF NOT EXISTS "sample_limit" integer;--> statement-breakpoint
ALTER TABLE "si_backlink_gap_snapshots" ADD COLUMN IF NOT EXISTS "exclusion_reasons" text;--> statement-breakpoint
ALTER TABLE "si_backlink_gap_snapshots" ADD COLUMN IF NOT EXISTS "calculated_at" text;
