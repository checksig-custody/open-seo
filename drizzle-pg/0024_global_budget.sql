-- One budget guard for the whole of Search Intelligence.
--
-- WHY THIS EXISTS. Each collector kept its own ledger and its own guard, and
-- each guard compared ITS OWN spend against the shared cap. On 2026-08-06 the
-- backlink guard saw zero backlink spend, allowed a 0.0792 USD collection, and
-- the day summed to 0.21400 USD against a 0.20 cap. No guard was bypassed;
-- there was no guard that could see the total.
--
-- Reading four ledgers is necessary but not sufficient: two collectors reading
-- the same remainder would both proceed. So capacity is RESERVED before the
-- call and reconciled after it, and the reservation is the thing a concurrent
-- caller can see.
--
-- Additive: one new table. No ledger is altered, and no recorded spend is
-- rewritten — the overrun stays in the record where it happened.
CREATE TABLE IF NOT EXISTS "si_budget_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	-- Supplied by the caller: the same logical operation retried must not
	-- reserve twice. UNIQUE below is what enforces that, not a prior read.
	"idempotency_key" text NOT NULL,
	"collector" text NOT NULL,
	"operation_type" text NOT NULL,
	"job_id" text,
	"operation_id" text,
	-- The worst case the caller asked to be allowed to spend. Capacity is held
	-- against THIS until the real cost is known.
	"estimated_max_cost_micros" integer NOT NULL,
	-- What it actually cost, once the provider says so. NULL while unknown —
	-- never 0, which would release capacity the call may still consume.
	"actual_cost_micros" integer,
	"cost_status" text,
	-- reserved | committed | released | expired | reconciliation_pending
	"status" text NOT NULL DEFAULT 'reserved',
	-- The budget day and month this reservation counts against, resolved once by
	-- the authority so a reservation and a ledger row can never disagree about
	-- which day they belong to.
	"budget_day" text NOT NULL,
	"budget_month" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"committed_at" text,
	"released_at" text,
	-- Sanitized, and only ever a code plus this engine's own words.
	"failure_reason" text
);--> statement-breakpoint

-- The whole concurrency guarantee: a retry of the same operation collides here
-- instead of reserving a second time.
CREATE UNIQUE INDEX IF NOT EXISTS "si_budget_reservations_idempotency_idx" ON "si_budget_reservations" ("idempotency_key");--> statement-breakpoint
-- The aggregate the authority reads on every authorization.
CREATE INDEX IF NOT EXISTS "si_budget_reservations_day_idx" ON "si_budget_reservations" ("budget_day","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_budget_reservations_month_idx" ON "si_budget_reservations" ("budget_month","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_budget_reservations_expiry_idx" ON "si_budget_reservations" ("status","expires_at");
