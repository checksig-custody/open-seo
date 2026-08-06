CREATE TABLE "si_anchor_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"anchor_text" text,
	"normalized_anchor" text NOT NULL,
	"category" text DEFAULT 'unknown' NOT NULL,
	"backlink_count" integer DEFAULT 0 NOT NULL,
	"referring_domain_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"snapshot_at" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"suspicious_signal" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_backlink_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"backlink_id" text,
	"referring_domain_id" text,
	"subject_domain" text,
	"severity" text DEFAULT 'info' NOT NULL,
	"channel" text DEFAULT 'intel' NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"risk_score" integer,
	"risk_classification" text,
	"reasons" text,
	"brand_protection_signals" text,
	"brand_protection_status" text DEFAULT 'no_known_signal' NOT NULL,
	"detected_at" text NOT NULL,
	"confirmed_at" text,
	"delivered_at" text,
	"suppression_reason" text,
	"review_status" text DEFAULT 'new' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" text,
	"review_note" text,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_backlink_gap_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"normalized_domain" text NOT NULL,
	"domain" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"category" text NOT NULL,
	"competitor_entity_ids" text DEFAULT '[]' NOT NULL,
	"links_primary" boolean DEFAULT false NOT NULL,
	"competitor_count" integer DEFAULT 0 NOT NULL,
	"domain_rank" integer,
	"spam_score" integer,
	"risk_classification" text,
	"opportunity_score" real,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_backlink_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" text,
	"finished_at" text,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_backlink_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"snapshot_at" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"backlink_count" integer,
	"referring_domain_count" integer,
	"dofollow_count" integer,
	"nofollow_count" integer,
	"new_backlinks" integer,
	"lost_backlinks" integer,
	"new_referring_domains" integer,
	"lost_referring_domains" integer,
	"comparison_status" text DEFAULT 'not_comparable' NOT NULL,
	"comparison_reason" text,
	"backlinks_processed" integer DEFAULT 0 NOT NULL,
	"domains_processed" integer DEFAULT 0 NOT NULL,
	"provider" text DEFAULT 'fixture' NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_backlink_usage_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"entity_id" text,
	"endpoint_path" text NOT NULL,
	"metering_class" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"metered_requests" integer DEFAULT 0 NOT NULL,
	"paid_tasks" integer DEFAULT 0 NOT NULL,
	"result_fetch_requests" integer DEFAULT 0 NOT NULL,
	"backlinks_processed" integer DEFAULT 0 NOT NULL,
	"domains_processed" integer DEFAULT 0 NOT NULL,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	"cache_misses" integer DEFAULT 0 NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_backlinks" (
	"id" text PRIMARY KEY NOT NULL,
	"target_entity_id" text NOT NULL,
	"source_url" text NOT NULL,
	"normalized_source_url" text NOT NULL,
	"source_domain" text NOT NULL,
	"normalized_source_domain" text NOT NULL,
	"target_url" text NOT NULL,
	"normalized_target_url" text NOT NULL,
	"anchor_text" text,
	"normalized_anchor" text,
	"link_type" text DEFAULT 'unknown' NOT NULL,
	"is_dofollow" boolean,
	"is_nofollow" boolean,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"lost_at" text,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text DEFAULT 'fixture' NOT NULL,
	"provider_backlink_id" text,
	"domain_rank" integer,
	"page_rank" integer,
	"spam_score" integer,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"actual_cost_micros" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_referring_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"domain" text NOT NULL,
	"normalized_domain" text NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"lost_at" text,
	"backlink_count" integer,
	"target_page_count" integer,
	"domain_rank" integer,
	"spam_score" integer,
	"country" text,
	"tld" text,
	"status" text DEFAULT 'active' NOT NULL,
	"risk_classification" text,
	"risk_score" integer,
	"risk_reasons" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "si_anchor_snapshots_dedupe_idx" ON "si_anchor_snapshots" USING btree ("entity_id","normalized_anchor","snapshot_date");--> statement-breakpoint
CREATE INDEX "si_anchor_snapshots_entity_idx" ON "si_anchor_snapshots" USING btree ("entity_id","snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "si_backlink_events_dedupe_idx" ON "si_backlink_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_backlink_events_entity_idx" ON "si_backlink_events" USING btree ("entity_id","detected_at");--> statement-breakpoint
CREATE INDEX "si_backlink_events_review_idx" ON "si_backlink_events" USING btree ("review_status","risk_classification");--> statement-breakpoint
CREATE INDEX "si_backlink_events_delivery_idx" ON "si_backlink_events" USING btree ("status","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "si_backlink_gap_dedupe_idx" ON "si_backlink_gap_snapshots" USING btree ("normalized_domain","snapshot_date");--> statement-breakpoint
CREATE INDEX "si_backlink_gap_category_idx" ON "si_backlink_gap_snapshots" USING btree ("snapshot_date","category");--> statement-breakpoint
CREATE UNIQUE INDEX "si_backlink_jobs_dedupe_idx" ON "si_backlink_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_backlink_jobs_status_idx" ON "si_backlink_jobs" USING btree ("status","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "si_backlink_snapshots_dedupe_idx" ON "si_backlink_snapshots" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_backlink_snapshots_entity_idx" ON "si_backlink_snapshots" USING btree ("entity_id","snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "si_backlink_usage_dedupe_idx" ON "si_backlink_usage_ledger" USING btree ("day","entity_id","endpoint_path","metering_class");--> statement-breakpoint
CREATE UNIQUE INDEX "si_backlinks_dedupe_idx" ON "si_backlinks" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_backlinks_target_idx" ON "si_backlinks" USING btree ("target_entity_id","status");--> statement-breakpoint
CREATE INDEX "si_backlinks_domain_idx" ON "si_backlinks" USING btree ("normalized_source_domain");--> statement-breakpoint
CREATE INDEX "si_backlinks_seen_idx" ON "si_backlinks" USING btree ("target_entity_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "si_referring_domains_dedupe_idx" ON "si_referring_domains" USING btree ("entity_id","normalized_domain");--> statement-breakpoint
CREATE INDEX "si_referring_domains_status_idx" ON "si_referring_domains" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "si_referring_domains_risk_idx" ON "si_referring_domains" USING btree ("risk_classification");