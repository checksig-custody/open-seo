-- Postgres mirror of `0050_reservation_resolution` (see the D1 migration).
--
-- `reconciliation_pending` had no exit: no function, no endpoint, no columns to
-- record what a resolution rested on, and a row in that state holds its full
-- worst case forever. `resolved_cost_micros` is deliberately separate from
-- `actual_cost_micros` so "the provider said" and "a human verified" stay
-- distinguishable. Additive and forward-only.
ALTER TABLE "si_budget_reservations" ADD COLUMN IF NOT EXISTS "resolved_cost_micros" integer;--> statement-breakpoint
ALTER TABLE "si_budget_reservations" ADD COLUMN IF NOT EXISTS "resolution_evidence" text;--> statement-breakpoint
ALTER TABLE "si_budget_reservations" ADD COLUMN IF NOT EXISTS "resolved_by" text;--> statement-breakpoint
ALTER TABLE "si_budget_reservations" ADD COLUMN IF NOT EXISTS "resolved_at" text;
