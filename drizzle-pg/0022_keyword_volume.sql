CREATE TABLE IF NOT EXISTS "si_keyword_volume_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tracked_keyword_id" text NOT NULL REFERENCES "tracked_keywords"("id") ON DELETE cascade,
	"keyword" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"search_engine" text DEFAULT 'google' NOT NULL,
	"search_volume" integer,
	"competition" real,
	"competition_level" text,
	"cost_per_click_micros" integer,
	"keyword_difficulty" integer,
	"search_intent" text,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"collected_at" text NOT NULL,
	"collection_window" text NOT NULL,
	"snapshot_status" text DEFAULT 'complete' NOT NULL,
	"snapshot_status_reason" text,
	"job_id" text,
	"provider_response_id" text,
	"dedupe_key" text NOT NULL,
	"created_at" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "si_keyword_volume_dedupe_idx" ON "si_keyword_volume_snapshots" ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_keyword_volume_keyword_idx" ON "si_keyword_volume_snapshots" ("tracked_keyword_id","collected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_keyword_volume_window_idx" ON "si_keyword_volume_snapshots" ("collection_window");--> statement-breakpoint
ALTER TABLE "share_of_search_snapshots" ADD COLUMN IF NOT EXISTS "eligible_keywords" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_of_search_snapshots" ADD COLUMN IF NOT EXISTS "excluded_keywords" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_of_search_snapshots" ADD COLUMN IF NOT EXISTS "exclusion_reasons" text;--> statement-breakpoint
ALTER TABLE "share_of_search_snapshots" ADD COLUMN IF NOT EXISTS "coverage" real;--> statement-breakpoint
ALTER TABLE "share_of_search_snapshots" ADD COLUMN IF NOT EXISTS "calculated_at" text;--> statement-breakpoint
ALTER TABLE "keyword_gap_snapshots" ADD COLUMN IF NOT EXISTS "opportunity_score_reason" text;
