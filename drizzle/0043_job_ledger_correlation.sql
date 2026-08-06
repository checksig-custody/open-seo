-- Make a job and its ledger rows describe the same operation.
--
-- Before this, `domain_refresh_jobs.estimated_cost_micros` and
-- `actual_cost_micros` were defaulted to 0 by `finishJob` because no caller
-- passed a cost, while the ledger recorded the real provider figure. One
-- operation, two records, disagreeing about whether it cost anything.
--
-- `job_id` is the correlation id. It is NOT NULL DEFAULT '' rather than
-- nullable because SQLite treats NULLs as distinct in a unique index: a
-- nullable column in the dedupe key would stop the upsert deduplicating and
-- turn one aggregate row into one row per call.
ALTER TABLE `search_usage_ledger` ADD `job_id` text DEFAULT '' NOT NULL;--> statement-breakpoint

-- The unique key gains `job_id` so usage is attributable to the operation that
-- caused it. Every consumer aggregates with SUM over a day or a month, and a
-- SUM does not care how many rows it spans, so no read changes meaning.
DROP INDEX IF EXISTS `search_usage_ledger_day_endpoint_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `search_usage_ledger_day_endpoint_idx` ON `search_usage_ledger` (`day`,`endpoint_path`,`metering_class`,`job_id`);--> statement-breakpoint
CREATE INDEX `search_usage_ledger_job_idx` ON `search_usage_ledger` (`job_id`);--> statement-breakpoint

-- Nullable on purpose: NULL means "written before this migration", where a zero
-- cost was a default rather than a measurement and must not be read as one.
ALTER TABLE `domain_refresh_jobs` ADD `cost_status` text;--> statement-breakpoint

-- RECONCILIATION of jobs that ran before the fix.
--
-- Deterministic, not heuristic: a job points at the snapshot it produced, and
-- that snapshot carries the cost of the collection that produced it. The link
-- is a stored foreign key, never a timestamp window or a domain match.
--
-- Idempotent — `actual_cost_micros = 0` means only rows still carrying the
-- default are touched, so re-running changes nothing.
--
-- Deliberately excluded: fixture snapshots (`source` must be `dataforseo`),
-- jobs with no snapshot, and any job whose snapshot records no spend. An
-- ambiguous row keeps its NULL `cost_status`, which says "unknown" rather than
-- asserting a number nobody measured.
UPDATE `domain_refresh_jobs`
SET
  `estimated_cost_micros` = (
    SELECT s.`estimated_cost_micros` FROM `domain_snapshots` s
    WHERE s.`id` = `domain_refresh_jobs`.`snapshot_id`
  ),
  `actual_cost_micros` = (
    SELECT s.`actual_cost_micros` FROM `domain_snapshots` s
    WHERE s.`id` = `domain_refresh_jobs`.`snapshot_id`
  ),
  `cost_status` = 'reported'
WHERE `status` = 'succeeded'
  AND `snapshot_id` IS NOT NULL
  AND `actual_cost_micros` = 0
  AND EXISTS (
    SELECT 1 FROM `domain_snapshots` s
    WHERE s.`id` = `domain_refresh_jobs`.`snapshot_id`
      AND s.`source` = 'dataforseo'
      AND s.`actual_cost_micros` > 0
  );
