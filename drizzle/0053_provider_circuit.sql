-- A suspended account is not a failed call, and must not be retried like one.
--
-- WHAT WAS MISSING. DataForSEO answers `40201` when it has suspended the
-- account — which is what it did to the second trial this subsystem was running
-- on. Nothing in this engine distinguished that from any other provider error.
-- The existing breaker in `si_provider_budget_state` counts consecutive
-- failures and closes itself after a cooldown, which is correct for a provider
-- having a bad ten minutes and precisely wrong here: every cooldown expiry would
-- resume calling a dead account, forever, across every collector.
--
-- SO THIS STATE IS LATCHED. No tick, no scheduler and no successful call to
-- another endpoint may clear it. `provider-circuit.ts` allows exactly three
-- exits, and all three are deliberate acts: the credential generation changes,
-- an admin resets it with an actor and a reason, or a FREE health check
-- demonstrates the account is usable. `cleared_at` / `clear_reason` /
-- `cleared_by` record which one happened, and `detected_at` survives it, so
-- "suspended since" stays answerable afterwards.
--
-- ONE ROW PER PROVIDER. The question is "may we call DataForSEO right now",
-- and that has one current answer; the history of how it got there lives in the
-- collection log. `40202` — rate limiting — deliberately does NOT write here:
-- it is a transient condition with a normal backoff, and latching it would turn
-- a busy minute into a permanent outage.
--
-- NO SECRET LANDS IN THIS TABLE. `sanitized_message` is provider text with
-- credentials and URLs stripped. `credential_generation` is a non-sensitive
-- label — `legacy_trial_2026_08`, `official_account_2026_08` — that says WHICH
-- account without being derivable back to it; it exists for accounting and
-- audit, and authenticates nothing.
--
-- Additive and forward-only. An absent row reads as "never observed", which is
-- not the same as healthy, and the code keeps those apart.
CREATE TABLE `si_provider_state` (
	`provider` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`detected_at` text NOT NULL,
	`last_checked_at` text,
	`cleared_at` text,
	`clear_reason` text,
	`cleared_by` text,
	`endpoint` text,
	`operation_type` text,
	`provider_status_code` integer,
	`sanitized_message` text,
	`job_id` text,
	`operation_id` text,
	`requires_attention` integer DEFAULT false NOT NULL,
	`credential_generation` text,
	`updated_at` text NOT NULL
);
