CREATE TABLE "domain_refresh_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text,
	"dedupe_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"skip_reason" text,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"snapshot_id" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"started_at" text,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "domain_snapshot_keywords" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"keyword" text NOT NULL,
	"rank_group" integer,
	"rank_absolute" integer,
	"search_volume" integer,
	"estimated_traffic" real,
	"cpc" real,
	"keyword_difficulty" integer,
	"search_intent" text,
	"ranking_url" text,
	"serp_updated_at" text,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_snapshot_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"estimated_traffic" real,
	"keyword_count" integer,
	"top_keyword" text,
	"top_keyword_position" integer,
	"page_title" text,
	"last_seen_at" text,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"organic_traffic_estimate" real,
	"organic_keyword_count" integer,
	"backlink_count" integer,
	"referring_domain_count" integer,
	"rank_signal" integer,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"source" text NOT NULL,
	"provider_request_id" text,
	"fetched_at" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_budget_state" (
	"month" text PRIMARY KEY NOT NULL,
	"monthly_cost_micros" integer DEFAULT 0 NOT NULL,
	"current_day" text,
	"daily_cost_micros" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"circuit_opened_at" text,
	"last_alert_threshold" integer,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"canonical_domain" text NOT NULL,
	"normalized_domain" text NOT NULL,
	"entity_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"include_subdomains" boolean DEFAULT false NOT NULL,
	"location_code" integer DEFAULT 2380 NOT NULL,
	"language_code" text DEFAULT 'it' NOT NULL,
	"refresh_interval_hours" integer DEFAULT 24 NOT NULL,
	"backlink_interval_hours" integer DEFAULT 168 NOT NULL,
	"last_refreshed_at" text,
	"last_backlink_refreshed_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"disabled_at" text
);
--> statement-breakpoint
CREATE TABLE "search_usage_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"entity_id" text,
	"endpoint_path" text NOT NULL,
	"metering_class" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"metered_requests" integer DEFAULT 0 NOT NULL,
	"failed_requests" integer DEFAULT 0 NOT NULL,
	"retry_requests" integer DEFAULT 0 NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	"cache_misses" integer DEFAULT 0 NOT NULL,
	"blocked_by_budget" integer DEFAULT 0 NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_refresh_jobs" ADD CONSTRAINT "domain_refresh_jobs_entity_id_search_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."search_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_snapshot_keywords" ADD CONSTRAINT "domain_snapshot_keywords_snapshot_id_domain_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."domain_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_snapshot_pages" ADD CONSTRAINT "domain_snapshot_pages_snapshot_id_domain_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."domain_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_snapshots" ADD CONSTRAINT "domain_snapshots_entity_id_search_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."search_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_refresh_jobs_dedupe_idx" ON "domain_refresh_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "domain_refresh_jobs_status_idx" ON "domain_refresh_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "domain_refresh_jobs_entity_idx" ON "domain_refresh_jobs" USING btree ("entity_id","created_at");--> statement-breakpoint
CREATE INDEX "domain_snapshot_keywords_snapshot_idx" ON "domain_snapshot_keywords" USING btree ("snapshot_id","position");--> statement-breakpoint
CREATE INDEX "domain_snapshot_pages_snapshot_idx" ON "domain_snapshot_pages" USING btree ("snapshot_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_snapshots_dedupe_idx" ON "domain_snapshots" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "domain_snapshots_entity_date_idx" ON "domain_snapshots" USING btree ("entity_id","snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "search_entities_domain_market_idx" ON "search_entities" USING btree ("normalized_domain","location_code","language_code");--> statement-breakpoint
CREATE INDEX "search_entities_enabled_idx" ON "search_entities" USING btree ("enabled","entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "search_usage_ledger_day_endpoint_idx" ON "search_usage_ledger" USING btree ("day","endpoint_path","metering_class");--> statement-breakpoint
CREATE INDEX "search_usage_ledger_day_idx" ON "search_usage_ledger" USING btree ("day");