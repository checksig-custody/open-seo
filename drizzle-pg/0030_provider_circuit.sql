-- Postgres mirror of `drizzle/0053_provider_circuit.sql`.
--
-- See that file for the reasoning: DataForSEO `40201` means the account is
-- suspended, which no cooldown fixes, so the state is latched and only three
-- deliberate acts can clear it. `40202` does not write here.
--
-- NOT APPLIED ANYWHERE YET — there is no remote Postgres; both deployments run
-- `DATABASE_PROVIDER: d1`. Kept in parity so a future Postgres deployment
-- inherits the same guarantees. "In parity" and "applied" are different claims.
CREATE TABLE "si_provider_state" (
	"provider" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"detected_at" text NOT NULL,
	"last_checked_at" text,
	"cleared_at" text,
	"clear_reason" text,
	"cleared_by" text,
	"endpoint" text,
	"operation_type" text,
	"provider_status_code" integer,
	"sanitized_message" text,
	"job_id" text,
	"operation_id" text,
	"requires_attention" boolean DEFAULT false NOT NULL,
	"credential_generation" text,
	"updated_at" text NOT NULL
);
