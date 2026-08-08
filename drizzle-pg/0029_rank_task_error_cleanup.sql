-- Postgres mirror of `drizzle/0052_rank_task_error_cleanup.sql`.
--
-- See that file for the full reasoning. In short: three `si_rank_tasks` rows are
-- `succeeded` while still carrying the diagnostics of a failure, left behind by
-- a premature failure marking that a later recovery corrected everywhere except
-- in these columns.
--
-- The predicate corroborates the success before trusting it: a provider receipt,
-- a closed lifecycle, and a stored snapshot correlated by `provider_task_id` —
-- NOT by `snapshot_id`, which is null on every row in this table.
--
-- NOT APPLIED ANYWHERE YET. There is no remote Postgres: both deployments run
-- `DATABASE_PROVIDER: d1`. This file exists so the two dialects stay in parity —
-- which CI asserts — and so a future Postgres deployment inherits the same
-- corrected history rather than a divergent one. "In parity" and "applied" are
-- different claims and this project keeps them apart.
--
-- Forward-only and idempotent.
UPDATE "si_rank_tasks"
   SET "error_origin" = NULL,
       "error_class" = NULL,
       "error_code" = NULL
 WHERE "status" = 'succeeded'
   AND "provider_task_id" IS NOT NULL
   AND "completed_at" IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM "si_rank_snapshots"
          WHERE "si_rank_snapshots"."provider_task_id" = "si_rank_tasks"."provider_task_id"
       );
