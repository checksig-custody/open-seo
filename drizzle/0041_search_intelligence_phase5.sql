CREATE TABLE `si_ai_visibility_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`query_id` text NOT NULL,
	`domain` text NOT NULL,
	`normalized_domain` text NOT NULL,
	`url` text,
	`entity_id` text,
	`citation_order` integer DEFAULT 0 NOT NULL,
	`title` text,
	`first_seen_at` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_ai_visibility_citations_dedupe_idx` ON `si_ai_visibility_citations` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_ai_visibility_citations_domain_idx` ON `si_ai_visibility_citations` (`normalized_domain`,`first_seen_at`);--> statement-breakpoint
CREATE INDEX `si_ai_visibility_citations_snapshot_idx` ON `si_ai_visibility_citations` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `si_ai_visibility_events` (
	`id` text PRIMARY KEY NOT NULL,
	`query_id` text NOT NULL,
	`event_type` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`domain` text,
	`magnitude` real,
	`reason` text NOT NULL,
	`channel` text DEFAULT 'none' NOT NULL,
	`delivery_status` text DEFAULT 'detected' NOT NULL,
	`delivered_at` text,
	`suppression_reason` text,
	`occurred_at` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_ai_visibility_events_dedupe_idx` ON `si_ai_visibility_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_ai_visibility_events_delivery_idx` ON `si_ai_visibility_events` (`delivery_status`,`channel`);--> statement-breakpoint
CREATE TABLE `si_ai_visibility_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`query` text NOT NULL,
	`normalized_query` text NOT NULL,
	`cluster` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`location_code` integer DEFAULT 2380 NOT NULL,
	`language_code` text DEFAULT 'it' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`check_interval_hours` integer DEFAULT 168 NOT NULL,
	`last_checked_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_ai_visibility_queries_identity_idx` ON `si_ai_visibility_queries` (`normalized_query`,`location_code`,`language_code`);--> statement-breakpoint
CREATE INDEX `si_ai_visibility_queries_enabled_idx` ON `si_ai_visibility_queries` (`enabled`,`priority`);--> statement-breakpoint
CREATE TABLE `si_ai_visibility_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`query_id` text NOT NULL,
	`provider` text NOT NULL,
	`engine` text NOT NULL,
	`checked_at` text NOT NULL,
	`ai_result_present` integer,
	`primary_brand_mentioned` integer,
	`primary_brand_cited` integer,
	`competitor_mentions` integer,
	`competitor_citations` integer,
	`cited_domain_count` integer,
	`organic_position` integer,
	`source` text NOT NULL,
	`provider_status` text DEFAULT 'not_configured' NOT NULL,
	`comparison_status` text DEFAULT 'not_comparable' NOT NULL,
	`estimated_cost_micros` integer DEFAULT 0 NOT NULL,
	`actual_cost_micros` integer DEFAULT 0 NOT NULL,
	`provider_request_id` text,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_ai_visibility_snapshots_dedupe_idx` ON `si_ai_visibility_snapshots` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_ai_visibility_snapshots_query_idx` ON `si_ai_visibility_snapshots` (`query_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `si_site_audit_frontier` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`normalized_url` text NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`discovered_from` text,
	`discovery_source` text DEFAULT 'link' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`skip_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_site_audit_frontier_identity_idx` ON `si_site_audit_frontier` (`run_id`,`normalized_url`);--> statement-breakpoint
CREATE INDEX `si_site_audit_frontier_state_idx` ON `si_site_audit_frontier` (`run_id`,`state`,`depth`);--> statement-breakpoint
CREATE TABLE `si_site_audit_issue_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`issue_type` text NOT NULL,
	`page_url` text,
	`event_type` text NOT NULL,
	`severity` text DEFAULT 'low' NOT NULL,
	`previous_run_id` text,
	`reason` text NOT NULL,
	`occurred_at` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_site_audit_issue_events_dedupe_idx` ON `si_site_audit_issue_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_site_audit_issue_events_run_idx` ON `si_site_audit_issue_events` (`run_id`,`event_type`);--> statement-breakpoint
CREATE TABLE `si_site_audit_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`page_id` text,
	`page_url` text,
	`issue_type` text NOT NULL,
	`category` text NOT NULL,
	`severity` text DEFAULT 'low' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`details` text,
	`change_state` text DEFAULT 'unknown' NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`resolved_at` text,
	`reviewed_by` text,
	`review_note` text,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_site_audit_issues_dedupe_idx` ON `si_site_audit_issues` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_site_audit_issues_run_idx` ON `si_site_audit_issues` (`run_id`,`severity`,`issue_type`);--> statement-breakpoint
CREATE INDEX `si_site_audit_issues_entity_idx` ON `si_site_audit_issues` (`entity_id`,`issue_type`,`status`);--> statement-breakpoint
CREATE TABLE `si_site_audit_links` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_url` text NOT NULL,
	`target_url` text NOT NULL,
	`anchor_text` text,
	`link_type` text DEFAULT 'internal' NOT NULL,
	`rel` text,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_site_audit_links_dedupe_idx` ON `si_site_audit_links` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_site_audit_links_target_idx` ON `si_site_audit_links` (`run_id`,`target_url`);--> statement-breakpoint
CREATE TABLE `si_site_audit_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`url` text NOT NULL,
	`normalized_url` text NOT NULL,
	`canonical_url` text,
	`status_code` integer,
	`content_type` text,
	`response_time_ms` integer,
	`depth` integer DEFAULT 0 NOT NULL,
	`title` text,
	`meta_description` text,
	`h1_count` integer DEFAULT 0 NOT NULL,
	`first_h1` text,
	`robots_directive` text,
	`indexable` integer,
	`indexability_reason` text,
	`content_length` integer,
	`text_length` integer,
	`internal_link_count` integer DEFAULT 0 NOT NULL,
	`external_link_count` integer DEFAULT 0 NOT NULL,
	`image_count` integer DEFAULT 0 NOT NULL,
	`images_missing_alt` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`redirect_chain_length` integer DEFAULT 0 NOT NULL,
	`final_url` text,
	`in_sitemap` integer DEFAULT false NOT NULL,
	`fetch_error` text,
	`crawled_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_site_audit_pages_identity_idx` ON `si_site_audit_pages` (`run_id`,`normalized_url`);--> statement-breakpoint
CREATE INDEX `si_site_audit_pages_run_idx` ON `si_site_audit_pages` (`run_id`,`status_code`);--> statement-breakpoint
CREATE INDEX `si_site_audit_pages_hash_idx` ON `si_site_audit_pages` (`run_id`,`content_hash`);--> statement-breakpoint
CREATE TABLE `si_site_audit_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`requested_by` text,
	`started_at` text,
	`completed_at` text,
	`deadline_at` text,
	`comparison_status` text DEFAULT 'not_comparable' NOT NULL,
	`page_limit` integer DEFAULT 100 NOT NULL,
	`pages_discovered` integer DEFAULT 0 NOT NULL,
	`pages_crawled` integer DEFAULT 0 NOT NULL,
	`pages_failed` integer DEFAULT 0 NOT NULL,
	`pages_blocked` integer DEFAULT 0 NOT NULL,
	`issues_total` integer DEFAULT 0 NOT NULL,
	`critical_count` integer DEFAULT 0 NOT NULL,
	`high_count` integer DEFAULT 0 NOT NULL,
	`medium_count` integer DEFAULT 0 NOT NULL,
	`low_count` integer DEFAULT 0 NOT NULL,
	`info_count` integer DEFAULT 0 NOT NULL,
	`site_health` real,
	`health_model_version` text,
	`truncated` integer DEFAULT false NOT NULL,
	`stop_reason` text,
	`sitemap_status` text DEFAULT 'not_checked' NOT NULL,
	`robots_status` text DEFAULT 'not_checked' NOT NULL,
	`bytes_fetched` integer DEFAULT 0 NOT NULL,
	`requests_made` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_site_audit_runs_dedupe_idx` ON `si_site_audit_runs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_site_audit_runs_entity_idx` ON `si_site_audit_runs` (`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `si_site_audit_runs_status_idx` ON `si_site_audit_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `si_site_audit_usage_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`entity_id` text,
	`run_id` text,
	`requests` integer DEFAULT 0 NOT NULL,
	`pages_processed` integer DEFAULT 0 NOT NULL,
	`bytes_fetched` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`blocked` integer DEFAULT 0 NOT NULL,
	`cache_hits` integer DEFAULT 0 NOT NULL,
	`cache_misses` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `si_site_audit_usage_day_idx` ON `si_site_audit_usage_ledger` (`day`,`entity_id`,`run_id`);