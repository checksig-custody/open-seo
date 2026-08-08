CREATE TABLE IF NOT EXISTS "si_rank_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"tracked_keyword_id" text NOT NULL REFERENCES "tracked_keywords"("id") ON DELETE cascade,
	"entity_id" text NOT NULL REFERENCES "search_entities"("id") ON DELETE cascade,
	"provider_task_id" text,
	"keyword" text NOT NULL,
	"target_domain" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"device" text NOT NULL,
	"search_engine" text DEFAULT 'google' NOT NULL,
	"collection_window" text NOT NULL,
	"status" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"submitted_at" text,
	"next_check_at" text,
	"last_checked_at" text,
	"completed_at" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_origin" text,
	"error_class" text,
	"error_code" text,
	"endpoint" text,
	"snapshot_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "si_rank_tasks_dedupe_idx" ON "si_rank_tasks" ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_rank_tasks_status_idx" ON "si_rank_tasks" ("status","next_check_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_rank_tasks_provider_idx" ON "si_rank_tasks" ("provider_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_rank_tasks_keyword_idx" ON "si_rank_tasks" ("tracked_keyword_id","collection_window");--> statement-breakpoint
ALTER TABLE "si_rank_snapshots" ADD COLUMN "ranking_domain" text;--> statement-breakpoint
ALTER TABLE "si_rank_snapshots" ADD COLUMN "result_type" text;--> statement-breakpoint
ALTER TABLE "si_rank_snapshots" ADD COLUMN "snapshot_status" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "si_rank_snapshots" ADD COLUMN "snapshot_status_reason" text;--> statement-breakpoint
ALTER TABLE "si_rank_snapshots" ADD COLUMN "provider_task_id" text;--> statement-breakpoint
ALTER TABLE "tracked_keywords" ADD COLUMN "created_source" text DEFAULT 'manual' NOT NULL;
