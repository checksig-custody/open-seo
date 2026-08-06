-- Phase 2 live rank collection: the persistent task lifecycle.
--
-- A queued SERP is charged when it is POSTED and answered seconds to minutes
-- later by a second, free call. Holding a Worker invocation open across that
-- gap would mean a deploy, a timeout or a subrequest ceiling could lose the
-- only record that money had been spent. So the submission and the collection
-- are separate operations joined by a row, and `provider_task_id` is the
-- receipt that makes the paid work recoverable — and makes a retry a fetch
-- rather than a second purchase.
--
-- Additive throughout: one new table and five nullable/defaulted columns.
CREATE TABLE `si_rank_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`tracked_keyword_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`provider_task_id` text,
	`keyword` text NOT NULL,
	`target_domain` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`device` text NOT NULL,
	`search_engine` text DEFAULT 'google' NOT NULL,
	`collection_window` text NOT NULL,
	`status` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`submitted_at` text,
	`next_check_at` text,
	`last_checked_at` text,
	`completed_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`error_origin` text,
	`error_class` text,
	`error_code` text,
	`endpoint` text,
	`snapshot_id` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`tracked_keyword_id`) REFERENCES `tracked_keywords`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `search_entities`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

-- The dedupe key is what stops a second paid submission for work already in
-- flight: keyword, entity, collection window, market and device together.
CREATE UNIQUE INDEX `si_rank_tasks_dedupe_idx` ON `si_rank_tasks` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_rank_tasks_status_idx` ON `si_rank_tasks` (`status`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `si_rank_tasks_provider_idx` ON `si_rank_tasks` (`provider_task_id`);--> statement-breakpoint
CREATE INDEX `si_rank_tasks_keyword_idx` ON `si_rank_tasks` (`tracked_keyword_id`,`collection_window`);--> statement-breakpoint

-- A stored rank keeps the provenance it was read from. Without `result_type` a
-- position cannot later be told apart from a featured snippet or a local pack,
-- and without `snapshot_status` a partial answer is indistinguishable from a
-- measurement — which matters because a partial observation must never be
-- allowed to confirm a lost ranking.
ALTER TABLE `si_rank_snapshots` ADD `ranking_domain` text;--> statement-breakpoint
ALTER TABLE `si_rank_snapshots` ADD `result_type` text;--> statement-breakpoint
ALTER TABLE `si_rank_snapshots` ADD `snapshot_status` text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE `si_rank_snapshots` ADD `snapshot_status_reason` text;--> statement-breakpoint
ALTER TABLE `si_rank_snapshots` ADD `provider_task_id` text;--> statement-breakpoint

-- Where a keyword came from, so a re-runnable bootstrap can tell its own rows
-- apart from an operator's edits and never overwrite them.
ALTER TABLE `tracked_keywords` ADD `created_source` text DEFAULT 'manual' NOT NULL;
