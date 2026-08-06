ALTER TABLE "search_usage_ledger" ADD COLUMN "cost_reported_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "search_usage_ledger" ADD COLUMN "cost_not_reported_requests" integer DEFAULT 0 NOT NULL;
