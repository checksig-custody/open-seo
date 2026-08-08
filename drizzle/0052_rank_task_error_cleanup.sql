-- A succeeded task cannot also have failed.
--
-- WHAT WAS WRONG. Three `si_rank_tasks` rows sit at `status = 'succeeded'` while
-- still carrying the diagnostics of a failure:
--
--   two   `provider` / `DataForSEOTaskStatus`  / `DATAFORSEO_TASK_FAILED`
--   one   `collection` / `CollectionRetryExhausted` / `DATAFORSEO_COLLECTION_RETRY_EXHAUSTED`
--
-- Both shapes come from the same event on 2026-08-07: three SERPs took ~50
-- minutes to arrive, the automatic tick gave up and marked them failed, and a
-- later `rank-recover` found them alive and completed them. `markSucceeded` now
-- clears these fields, but it was written after these rows and does not
-- backfill. The result reads as impossible, and anything reasoning over
-- `error_origin` — an alert, a health view, an operator — is reading a lie.
--
-- WHY A MIGRATION AND NOT A SCRIPT. This is a correction to persisted history,
-- and history corrections belong where they are reviewable, ordered and applied
-- exactly once to each database. A one-off `d1 execute` is none of those.
--
-- THE PREDICATE IS THE WHOLE POINT. Only rows where the success is independently
-- corroborated are touched:
--
--   * `status = 'succeeded'`            — the claim being trusted
--   * `provider_task_id IS NOT NULL`    — a provider receipt exists
--   * `completed_at IS NOT NULL`        — the lifecycle actually closed
--   * a `si_rank_snapshots` row exists for that same `provider_task_id`
--                                       — the SERP was not only fetched but
--                                         normalized and stored
--
-- The last one is the correlation that matters, and it is NOT `snapshot_id`:
-- that column is null on every row in this table, because `markSucceeded` is
-- called with `snapshotId: null` and snapshots are keyed by provider task id
-- instead (one row per tracked entity). A predicate on `snapshot_id` would have
-- matched nothing and quietly changed nothing, which is the failure mode this
-- comment exists to prevent someone repeating.
--
-- The two `failed` rows are deliberately NOT touched. They hold no provider task
-- id — their `task_post` was answered but returned none — so their failure is
-- real and their diagnostics are true. They are also the two reservations still
-- in `reconciliation_pending`, and rewriting their error state would erase the
-- evidence a human needs to settle them.
--
-- WHAT IS PRESERVED. Everything except the three error columns: `id`,
-- `provider_task_id`, `tracked_keyword_id`, `dedupe_key`, `endpoint`,
-- `submitted_at`, `completed_at`, `attempt_count`, every accounting row, every
-- snapshot. No provider call, no cost, no timestamp is invented.
--
-- Forward-only and idempotent: re-running it selects nothing, because the rows
-- it would match no longer have anything to clear.
UPDATE `si_rank_tasks`
   SET `error_origin` = NULL,
       `error_class` = NULL,
       `error_code` = NULL
 WHERE `status` = 'succeeded'
   AND `provider_task_id` IS NOT NULL
   AND `completed_at` IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM `si_rank_snapshots`
          WHERE `si_rank_snapshots`.`provider_task_id` = `si_rank_tasks`.`provider_task_id`
       );
