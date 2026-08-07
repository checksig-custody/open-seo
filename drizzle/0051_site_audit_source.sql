-- Site Audit states its provenance instead of having it assumed.
--
-- WHAT WAS WRONG. `readiness-facts.ts` counted site-audit runs with `1 = 1`,
-- the only fact in that file with no provenance filter — its own comment says
-- "a row that came from a provider counts, a fixture does not", and this was
-- the exception. So a `queued` run that never advanced, a half-crawled
-- `running` run, and a `failed` run all satisfied the Site Audit readiness
-- gate. A bare request with no crawl behind it would have read as verification.
--
-- There was no column to filter on. Every other capability asserts where its
-- data came from — `domain_snapshots.source`, `si_backlink_snapshots.source`,
-- `si_rank_snapshots.provider` — and Site Audit inferred it from the absence of
-- a fixture path. That happens to be true today and is not checkable, which is
-- the same class of claim this subsystem has been removing everywhere else.
--
-- `first_party_crawl` is the honest value: Site Audit fetches the entity's own
-- pages through the SSRF boundary and buys nothing from any provider, which is
-- also why its ledger has no cost columns and why the budget authority
-- deliberately excludes it.
--
-- Backfill is a no-op by fact, not by assumption: there are zero rows in this
-- table, and there has never been a fixture writer for it. The statement is
-- included anyway so the column is never left half-populated if that changes
-- between authoring and applying.
--
-- Additive and forward-only.
ALTER TABLE `si_site_audit_runs` ADD `source` text;--> statement-breakpoint

UPDATE `si_site_audit_runs`
   SET `source` = 'first_party_crawl'
 WHERE `source` IS NULL;
