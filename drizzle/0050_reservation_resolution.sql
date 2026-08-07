-- A way out of `reconciliation_pending` that cannot be taken with a guess.
--
-- WHAT WAS WRONG. `reconciliation_pending` was a terminal state with no exit.
-- Nothing transitioned out of it: no function, no endpoint, and no columns to
-- record what a resolution was based on. A row in that state holds its full
-- worst-case capacity forever (`HOLDING_STATUSES` includes it) and counts
-- toward a hard, never-waivable release blocker.
--
-- Two such rows exist right now, from two `task_post` calls on 2026-08-07 that
-- were answered and billed but returned no task id. Their cost is genuinely
-- unknown — the code read it and threw it away, which is fixed separately — and
-- the only honest source for it is DataForSEO's own invoice.
--
-- SO THE EXIT REQUIRES EVIDENCE, NOT A NUMBER. `resolved_cost_micros` is
-- deliberately a SEPARATE column from `actual_cost_micros`: the latter is what
-- the provider reported at the time, and overwriting it would destroy the
-- distinction between "the provider said" and "a human verified". A resolution
-- without `resolution_evidence` and `resolved_by` is refused in code — the
-- columns exist so that refusal has something to insist on.
--
-- `resolved` joins the status vocabulary as a fourth terminal state alongside
-- `committed`, `released` and `expired`. It stops holding capacity, because by
-- then the money is known.
--
-- Follows the engine's existing actor convention (`si_backlink_events`,
-- `si_site_audit_issues`): an opaque `*_by` string, never an email, never an
-- identity lookup, with an ISO-8601 text timestamp beside it.
--
-- Additive and forward-only. Every existing row keeps its meaning and NULL
-- reads as "never reconciled", which is exactly what those two rows are.
ALTER TABLE `si_budget_reservations` ADD `resolved_cost_micros` integer;--> statement-breakpoint
ALTER TABLE `si_budget_reservations` ADD `resolution_evidence` text;--> statement-breakpoint
ALTER TABLE `si_budget_reservations` ADD `resolved_by` text;--> statement-breakpoint
ALTER TABLE `si_budget_reservations` ADD `resolved_at` text;
