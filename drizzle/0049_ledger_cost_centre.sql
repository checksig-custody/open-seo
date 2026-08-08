-- Which collector spent it — a label on the money, not a new place to put it.
--
-- WHAT WAS WRONG. Three cost centres write to `search_usage_ledger`: the
-- phase-1 Domain Overview collector, the SERP ranking collector, and Keyword
-- Volume. All three call the same `recordUsage`, and the budget authority read
-- the whole table under one name. So `per_collector` reported every micro-USD
-- of ranking and volume spend as `domain_overview`, the `phase2` row sat at a
-- permanent zero, and the readiness matrix showed a null cost for a collector
-- that had demonstrably been paid for.
--
-- WHY NOT MOVE THE ROWS. The obvious fix — route SERP into
-- `phase2_usage_ledger` — is worse than the bug. That table has no `job_id`,
-- `entity_id`, `endpoint_path`, `metering_class`, `failed_requests`, and
-- neither of the `cost_reported_requests` / `cost_not_reported_requests` pair
-- that `0042` and `0043` added precisely so a budget guard cannot be silently
-- wrong. Its unique key is `(day, job_type)`. Relabelling by discarding the
-- correlation is not a fix, and moving money between tables to correct a name
-- is a migration that can be arithmetically wrong.
--
-- Splitting the READ instead keeps the global total invariant BY CONSTRUCTION:
-- the same rows, in the same table, summed the same way. Only the grouping
-- changes.
--
-- THE BACKFILL IS A LABEL, NOT AN ESTIMATE. `endpoint_path` partitions the
-- existing rows with no overlap and no ambiguity — it is the correlation those
-- rows already carry, not a heuristic over timestamps. Verified against
-- production before it was written: SERP 2 400 µUSD, keyword overview 12 840,
-- the remaining Labs endpoints 121 320. No row changes table and no micro-USD
-- changes value.
--
-- Additive and forward-only. NULL keeps its own meaning for any row a future
-- writer forgets to label, which the authority reports rather than hides.
ALTER TABLE `search_usage_ledger` ADD `cost_centre` text;--> statement-breakpoint

-- The SERP lifecycle: task_post buys a ranking, task_get collects it for free.
UPDATE `search_usage_ledger`
   SET `cost_centre` = 'ranking'
 WHERE `cost_centre` IS NULL
   AND `endpoint_path` LIKE '%serp/google/organic/%';--> statement-breakpoint

-- Keyword Volume is one Labs endpoint and must not be folded into the other.
UPDATE `search_usage_ledger`
   SET `cost_centre` = 'keyword_volume'
 WHERE `cost_centre` IS NULL
   AND `endpoint_path` LIKE '%keyword_overview%';--> statement-breakpoint

-- Everything else in this table is the phase-1 Domain Overview collector:
-- domain_rank_overview, ranked_keywords and relevant_pages.
UPDATE `search_usage_ledger`
   SET `cost_centre` = 'domain_overview'
 WHERE `cost_centre` IS NULL;--> statement-breakpoint

-- The aggregate the authority now groups by.
CREATE INDEX `search_usage_ledger_cost_centre_idx` ON `search_usage_ledger` (`day`,`cost_centre`);
