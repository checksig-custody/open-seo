-- Phase 2 keyword intelligence: search volume as measured history.
--
-- `tracked_keywords.search_volume` is a single mutable cell — the current read
-- model that Keyword Gap and Share of Search already weight by. It answers
-- "what is the volume now" and cannot answer "what did we measure, when, from
-- where, and at what cost", which is the question every other number in this
-- subsystem can answer about itself.
--
-- So the measurement gets its own immutable row and the cell stays the read
-- model. A collection writes both; nothing rewrites a snapshot.
CREATE TABLE `si_keyword_volume_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tracked_keyword_id` text NOT NULL,
	`keyword` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`search_engine` text DEFAULT 'google' NOT NULL,
	-- NULL is "the provider did not tell us", 0 is "the provider said zero".
	-- Two different facts, and collapsing them would make an unmeasured keyword
	-- indistinguishable from one nobody searches for.
	`search_volume` integer,
	`competition` real,
	`competition_level` text,
	`cost_per_click_micros` integer,
	`keyword_difficulty` integer,
	`search_intent` text,
	`provider` text NOT NULL,
	-- `dataforseo` or `fixture`. A production engine refuses to write the second.
	`source` text NOT NULL,
	`collected_at` text NOT NULL,
	`collection_window` text NOT NULL,
	-- `complete` when the provider answered for this keyword; `no_data` when it
	-- answered and knows nothing; `partial` when the answer was incomplete.
	`snapshot_status` text DEFAULT 'complete' NOT NULL,
	`snapshot_status_reason` text,
	-- The operation that paid for it, so a volume can be traced to its cost.
	`job_id` text,
	`provider_response_id` text,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`tracked_keyword_id`) REFERENCES `tracked_keywords`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

-- One measurement per keyword, market and window. A repeated collection in the
-- same window hits this and writes nothing rather than duplicating history.
CREATE UNIQUE INDEX `si_keyword_volume_dedupe_idx` ON `si_keyword_volume_snapshots` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `si_keyword_volume_keyword_idx` ON `si_keyword_volume_snapshots` (`tracked_keyword_id`,`collected_at`);--> statement-breakpoint
CREATE INDEX `si_keyword_volume_window_idx` ON `si_keyword_volume_snapshots` (`collection_window`);--> statement-breakpoint

-- When a share of search cannot be computed, say how far off it was.
--
-- `keywords_considered` and `keywords_covered` were not enough to tell "nobody
-- has a volume yet" from "half the watchlist has no position": both arrive as
-- `insufficient_data` with a sentence. These columns make the shortfall
-- countable, and `exclusion_reasons` says which keywords were dropped and why.
ALTER TABLE `share_of_search_snapshots` ADD `eligible_keywords` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `share_of_search_snapshots` ADD `excluded_keywords` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `share_of_search_snapshots` ADD `exclusion_reasons` text;--> statement-breakpoint
ALTER TABLE `share_of_search_snapshots` ADD `coverage` real;--> statement-breakpoint
ALTER TABLE `share_of_search_snapshots` ADD `calculated_at` text;--> statement-breakpoint

-- Why an opportunity score is absent, rather than only that it is.
ALTER TABLE `keyword_gap_snapshots` ADD `opportunity_score_reason` text;
