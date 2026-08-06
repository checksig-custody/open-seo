ALTER TABLE "search_usage_ledger" ADD COLUMN "job_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "search_usage_ledger_day_endpoint_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "search_usage_ledger_day_endpoint_idx" ON "search_usage_ledger" ("day","endpoint_path","metering_class","job_id");--> statement-breakpoint
CREATE INDEX "search_usage_ledger_job_idx" ON "search_usage_ledger" ("job_id");--> statement-breakpoint
ALTER TABLE "domain_refresh_jobs" ADD COLUMN "cost_status" text;--> statement-breakpoint
UPDATE "domain_refresh_jobs"
SET
  "estimated_cost_micros" = s."estimated_cost_micros",
  "actual_cost_micros" = s."actual_cost_micros",
  "cost_status" = 'reported'
FROM "domain_snapshots" s
WHERE s."id" = "domain_refresh_jobs"."snapshot_id"
  AND "domain_refresh_jobs"."status" = 'succeeded'
  AND "domain_refresh_jobs"."actual_cost_micros" = 0
  AND s."source" = 'dataforseo'
  AND s."actual_cost_micros" > 0;
