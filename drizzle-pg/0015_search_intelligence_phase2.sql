CREATE TABLE "keyword_clusters" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"weight" real DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyword_gap_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tracked_keyword_id" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"category" text NOT NULL,
	"primary_rank" integer,
	"best_competitor_rank" integer,
	"best_competitor_entity_id" text,
	"opportunity_score" real,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phase2_usage_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"job_type" text NOT NULL,
	"http_requests" integer DEFAULT 0 NOT NULL,
	"metered_requests" integer DEFAULT 0 NOT NULL,
	"paid_tasks" integer DEFAULT 0 NOT NULL,
	"keywords_checked" integer DEFAULT 0 NOT NULL,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	"cache_misses" integer DEFAULT 0 NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"blocked_by_budget" integer DEFAULT 0 NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tracked_keyword_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"event_type" text NOT NULL,
	"previous_rank" integer,
	"current_rank" integer,
	"competitor_entity_id" text,
	"ranking_url" text,
	"detected_at" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"notified_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"tracked_keyword_id" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text NOT NULL,
	"scheduled_at" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"skip_reason" text,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"started_at" text,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "share_of_search_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"cluster_id" text,
	"snapshot_date" text NOT NULL,
	"visibility_score" real,
	"share" real,
	"status" text NOT NULL,
	"reason" text,
	"keywords_considered" integer DEFAULT 0 NOT NULL,
	"keywords_covered" integer DEFAULT 0 NOT NULL,
	"ctr_model_version" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_rank_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tracked_keyword_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"snapshot_at" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"device" text NOT NULL,
	"rank_group" integer,
	"rank_absolute" integer,
	"ranking_url" text,
	"normalized_ranking_url" text,
	"is_found" boolean NOT NULL,
	"provider" text NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_keywords" (
	"id" text PRIMARY KEY NOT NULL,
	"keyword" text NOT NULL,
	"normalized_keyword" text NOT NULL,
	"cluster_id" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"location_code" integer DEFAULT 2380 NOT NULL,
	"language_code" text DEFAULT 'it' NOT NULL,
	"device" text DEFAULT 'desktop' NOT NULL,
	"tracking_frequency_hours" integer DEFAULT 168 NOT NULL,
	"tracking_enabled" boolean DEFAULT true NOT NULL,
	"alerting_enabled" boolean DEFAULT true NOT NULL,
	"search_volume" integer,
	"last_checked_at" text,
	"next_check_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"disabled_at" text
);
--> statement-breakpoint
ALTER TABLE "keyword_gap_snapshots" ADD CONSTRAINT "keyword_gap_snapshots_tracked_keyword_id_tracked_keywords_id_fk" FOREIGN KEY ("tracked_keyword_id") REFERENCES "public"."tracked_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_of_search_snapshots" ADD CONSTRAINT "share_of_search_snapshots_entity_id_search_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."search_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "si_rank_snapshots" ADD CONSTRAINT "si_rank_snapshots_tracked_keyword_id_tracked_keywords_id_fk" FOREIGN KEY ("tracked_keyword_id") REFERENCES "public"."tracked_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "si_rank_snapshots" ADD CONSTRAINT "si_rank_snapshots_entity_id_search_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."search_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_keywords" ADD CONSTRAINT "tracked_keywords_cluster_id_keyword_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."keyword_clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_clusters_slug_idx" ON "keyword_clusters" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_gap_snapshots_dedupe_idx" ON "keyword_gap_snapshots" USING btree ("tracked_keyword_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "keyword_gap_snapshots_date_idx" ON "keyword_gap_snapshots" USING btree ("snapshot_date","category");--> statement-breakpoint
CREATE UNIQUE INDEX "phase2_usage_ledger_day_job_idx" ON "phase2_usage_ledger" USING btree ("day","job_type");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_events_dedupe_idx" ON "ranking_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ranking_events_detected_idx" ON "ranking_events" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_jobs_dedupe_idx" ON "ranking_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ranking_jobs_queue_idx" ON "ranking_jobs" USING btree ("status","priority","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "share_of_search_dedupe_idx" ON "share_of_search_snapshots" USING btree ("entity_id","cluster_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "share_of_search_date_idx" ON "share_of_search_snapshots" USING btree ("snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "si_rank_snapshots_dedupe_idx" ON "si_rank_snapshots" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_rank_snapshots_keyword_date_idx" ON "si_rank_snapshots" USING btree ("tracked_keyword_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "si_rank_snapshots_entity_date_idx" ON "si_rank_snapshots" USING btree ("entity_id","snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_keywords_keyword_market_idx" ON "tracked_keywords" USING btree ("normalized_keyword","location_code","language_code","device");--> statement-breakpoint
CREATE INDEX "tracked_keywords_due_idx" ON "tracked_keywords" USING btree ("tracking_enabled","next_check_at");--> statement-breakpoint
CREATE INDEX "tracked_keywords_cluster_idx" ON "tracked_keywords" USING btree ("cluster_id");