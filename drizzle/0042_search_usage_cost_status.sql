-- Distinguish "the provider said this was free" from "the provider said
-- nothing about cost". Both previously landed as actual_cost_micros = 0, which
-- makes an under-report indistinguishable from a measurement.
--
-- Additive: two counters with defaults, no backfill. Existing rows keep 0/0,
-- which is honest — nothing recorded before this migration knows which it was.
ALTER TABLE `search_usage_ledger` ADD `cost_reported_requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `search_usage_ledger` ADD `cost_not_reported_requests` integer DEFAULT 0 NOT NULL;
