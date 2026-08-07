-- Postgres mirror of `0048_reservation_subject` (see the D1 migration for why).
--
-- A reservation that records what it authorised, not only how much: `subject`
-- is the target the operation ran against, `subject_scope` the size of the
-- question asked. Additive, forward-only, both nullable.
ALTER TABLE "si_budget_reservations" ADD COLUMN IF NOT EXISTS "subject" text;--> statement-breakpoint
ALTER TABLE "si_budget_reservations" ADD COLUMN IF NOT EXISTS "subject_scope" integer;
