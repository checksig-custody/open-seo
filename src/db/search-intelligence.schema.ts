import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Morgana Search Intelligence — phase 1 schema (SQLite/D1).
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Mirrored byte-for-structure in `src/db/pg/search-intelligence.schema.ts`;
 * `schema-parity.test.ts` fails the build if the two drift.
 *
 * Deliberately standalone: no FK to `projects` or `organization`. These tables
 * describe a domain watch-list that exists independently of OpenSEO's
 * multi-tenant project model, which this deployment does not use (nobody can
 * log into the engine — it is a private Worker behind a Service Binding).
 * Keeping them unscoped also keeps them generic enough to remain in the public
 * fork without carrying company structure.
 *
 * MONEY IS INTEGER MICRO-USD everywhere, matching Morgana's convention
 * (decision #3): floats never touch a currency value.
 */

/**
 * The configured domains. Data-driven on purpose — nothing in the application
 * hardcodes a competitor, so adding or retiring one is a row change.
 */
export const searchEntities = sqliteTable(
  "search_entities",
  {
    id: text("id").primaryKey(),
    /** Human label. Never used as a key — renaming must not orphan history. */
    displayName: text("display_name").notNull(),
    /** As entered, for display. */
    canonicalDomain: text("canonical_domain").notNull(),
    /** Lowercased, protocol/www/path stripped, IDN→punycode. The match key. */
    normalizedDomain: text("normalized_domain").notNull(),
    entityType: text("entity_type", {
      enum: ["primary", "competitor", "watch"],
    }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    priority: text("priority", { enum: ["high", "normal", "low"] })
      .notNull()
      .default("normal"),
    includeSubdomains: integer("include_subdomains", { mode: "boolean" })
      .notNull()
      .default(false),
    /** DataForSEO location code. 2380 = Italy. */
    locationCode: integer("location_code").notNull().default(2380),
    languageCode: text("language_code").notNull().default("it"),
    /**
     * How often a scheduled refresh is due, in hours. Held per entity rather
     * than derived from `priority` so one domain can be retuned without
     * reclassifying it.
     */
    refreshIntervalHours: integer("refresh_interval_hours")
      .notNull()
      .default(24),
    /**
     * Backlink metrics refresh far less often than organic ones: the backlinks
     * summary endpoint costs roughly thirty times the domain rank overview, and
     * referring-domain counts move slowly. This is the single biggest lever on
     * monthly spend.
     */
    backlinkIntervalHours: integer("backlink_interval_hours")
      .notNull()
      .default(168),
    lastRefreshedAt: text("last_refreshed_at"),
    lastBacklinkRefreshedAt: text("last_backlink_refreshed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    /** Set instead of deleting: disabling an entity must preserve its history. */
    disabledAt: text("disabled_at"),
  },
  (table) => [
    // One entity per domain+market. The same domain may legitimately be tracked
    // in two markets, so the market is part of the identity.
    uniqueIndex("search_entities_domain_market_idx").on(
      table.normalizedDomain,
      table.locationCode,
      table.languageCode,
    ),
    index("search_entities_enabled_idx").on(table.enabled, table.entityType),
  ],
);

/**
 * One row per domain per market per snapshot period. Metrics are nullable
 * throughout: a provider that returns no value must produce `null`, never a
 * zero, or every comparison and delta silently becomes a lie.
 */
export const domainSnapshots = sqliteTable(
  "domain_snapshots",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => searchEntities.id, { onDelete: "cascade" }),
    organicTrafficEstimate: real("organic_traffic_estimate"),
    organicKeywordCount: integer("organic_keyword_count"),
    backlinkCount: integer("backlink_count"),
    referringDomainCount: integer("referring_domain_count"),
    /** Provider authority/rank signal, whatever the provider exposes. */
    rankSignal: integer("rank_signal"),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    /** `dataforseo` in production, `fixture` when running without credentials. */
    source: text("source", { enum: ["dataforseo", "fixture"] }).notNull(),
    providerRequestId: text("provider_request_id"),
    fetchedAt: text("fetched_at").notNull(),
    /** UTC date bucket (YYYY-MM-DD) this snapshot represents. */
    snapshotDate: text("snapshot_date").notNull(),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    /**
     * `entity|location|language|snapshotDate`. UNIQUE, and the whole reason
     * retries, a concurrent manual refresh, a duplicated scheduler tick and a
     * provider timeout-after-success cannot produce two snapshots for one day.
     */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("domain_snapshots_dedupe_idx").on(table.dedupeKey),
    index("domain_snapshots_entity_date_idx").on(
      table.entityId,
      table.snapshotDate,
    ),
  ],
);

/**
 * Top organic keywords, attached to the SNAPSHOT rather than the entity, so the
 * historical state is reconstructable exactly rather than only the latest.
 */
export const domainSnapshotKeywords = sqliteTable(
  "domain_snapshot_keywords",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => domainSnapshots.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    /**
     * `rank_group` and `rank_absolute` are kept distinct because they answer
     * different questions: rank_group is the organic position a human would
     * call "position 3", rank_absolute counts every SERP element including ads
     * and features. The UI shows rank_group.
     */
    rankGroup: integer("rank_group"),
    rankAbsolute: integer("rank_absolute"),
    searchVolume: integer("search_volume"),
    estimatedTraffic: real("estimated_traffic"),
    cpc: real("cpc"),
    keywordDifficulty: integer("keyword_difficulty"),
    searchIntent: text("search_intent"),
    rankingUrl: text("ranking_url"),
    serpUpdatedAt: text("serp_updated_at"),
    position: integer("position").notNull(),
  },
  (table) => [
    index("domain_snapshot_keywords_snapshot_idx").on(
      table.snapshotId,
      table.position,
    ),
  ],
);

/** Top organic pages, likewise attached to the snapshot. */
export const domainSnapshotPages = sqliteTable(
  "domain_snapshot_pages",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => domainSnapshots.id, { onDelete: "cascade" }),
    /** As returned by the provider. */
    url: text("url").notNull(),
    /** Protocol/www/trailing-slash/fragment/tracking-param stripped. */
    normalizedUrl: text("normalized_url").notNull(),
    estimatedTraffic: real("estimated_traffic"),
    keywordCount: integer("keyword_count"),
    topKeyword: text("top_keyword"),
    topKeywordPosition: integer("top_keyword_position"),
    pageTitle: text("page_title"),
    lastSeenAt: text("last_seen_at"),
    position: integer("position").notNull(),
  },
  (table) => [
    index("domain_snapshot_pages_snapshot_idx").on(
      table.snapshotId,
      table.position,
    ),
  ],
);

/**
 * Refresh jobs. A row is the unit of work AND the concurrency control: the
 * partial unique index below is what makes "one active job per entity" true
 * even with a scheduler tick and a manual refresh racing.
 */
export const domainRefreshJobs = sqliteTable(
  "domain_refresh_jobs",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => searchEntities.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed", "skipped"],
    }).notNull(),
    trigger: text("trigger", { enum: ["scheduled", "manual"] }).notNull(),
    /** Opaque actor reference; never an email. */
    requestedBy: text("requested_by"),
    /** `entity|snapshotDate|trigger` — collapses duplicate requests. */
    dedupeKey: text("dedupe_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Sanitized: never a stack trace or a provider credential. */
    lastError: text("last_error"),
    skipReason: text("skip_reason"),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    /**
     * What the provider said about the cost of THIS job's collection.
     *
     * Nullable, and null means "written before the accounting fix": those rows
     * carry a zero cost that was a default, not a measurement, and must not be
     * read as one.
     */
    costStatus: text("cost_status", {
      enum: ["reported", "zero", "not_reported"],
    }),
    snapshotId: text("snapshot_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    uniqueIndex("domain_refresh_jobs_dedupe_idx").on(table.dedupeKey),
    index("domain_refresh_jobs_status_idx").on(table.status, table.createdAt),
    index("domain_refresh_jobs_entity_idx").on(table.entityId, table.createdAt),
  ],
);

/**
 * Per-day, per-endpoint usage. `requests` counts every call made; only
 * `meteredRequests` counts against a cap.
 *
 * Brand Monitoring learned this the hard way (decision #84): DataForSEO's free
 * `task_get` polls were counted as requests and rationed the paid work, burning
 * 100% of the request allowance on 22% of the money. Search Intelligence
 * separates the two from day one.
 */
export const searchUsageLedger = sqliteTable(
  "search_usage_ledger",
  {
    id: text("id").primaryKey(),
    /** UTC day, YYYY-MM-DD. */
    day: text("day").notNull(),
    entityId: text("entity_id"),
    /**
     * The refresh job this usage belongs to — the correlation id that makes
     * "what did this job cost" answerable from the ledger itself.
     *
     * Empty string, never null, for usage with no job (and for every row
     * written before this column existed): SQLite treats NULLs as distinct in a
     * unique index, so a nullable column here would silently stop the upsert
     * deduplicating and turn one aggregate row into one row per call.
     */
    jobId: text("job_id").notNull().default(""),
    /**
     * WHICH COLLECTOR SPENT THIS, as a stored fact rather than a guess.
     *
     * Three cost centres share this table — the phase-1 Domain Overview, SERP
     * ranking and Keyword Volume — and until this column existed they were
     * distinguishable only by `endpoint_path`. The budget authority read the
     * table as a whole and labelled all of it `domain_overview`, so ranking
     * spend was reported against a collector that had not made the call, and
     * the collector that had reported zero forever.
     *
     * Deliberately NOT a fix by moving rows to another table: `actual_cost_micros`
     * is what the global cap is summed from, and a cost centre is a label on
     * money, not a place to put it. Splitting the READ keeps the total invariant
     * by construction.
     *
     * Nullable, and null means "written before this column existed" — which the
     * backfill in `0049` resolves from `endpoint_path`, the only reliable
     * correlation those rows carry.
     */
    costCentre: text("cost_centre", {
      enum: ["domain_overview", "ranking", "keyword_volume"],
    }),
    /** DataForSEO path, joined with '/'. */
    endpointPath: text("endpoint_path").notNull(),
    meteringClass: text("metering_class", {
      enum: [
        "paid_submission",
        "free_poll",
        "result_fetch",
        "quota_metered_free",
        "cache",
      ],
    }).notNull(),
    requests: integer("requests").notNull().default(0),
    meteredRequests: integer("metered_requests").notNull().default(0),
    failedRequests: integer("failed_requests").notNull().default(0),
    retryRequests: integer("retry_requests").notNull().default(0),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    /** Taken from the provider response, not guessed. */
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    /**
     * How many of these requests came back with a cost the provider stated,
     * and how many did not.
     *
     * Without this pair, `actual_cost_micros = 0` is ambiguous: it reads the
     * same whether DataForSEO said "this was free" or said nothing at all. The
     * first is a measurement; the second is a gap, and a budget that cannot
     * tell them apart will under-report spend and never know it.
     *
     * Counters rather than a status column because this row is an aggregate —
     * one row per day/endpoint/class, accumulated by upsert — so a single enum
     * would have to pick a winner across calls that disagreed.
     */
    costReportedRequests: integer("cost_reported_requests")
      .notNull()
      .default(0),
    costNotReportedRequests: integer("cost_not_reported_requests")
      .notNull()
      .default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
    cacheMisses: integer("cache_misses").notNull().default(0),
    blockedByBudget: integer("blocked_by_budget").notNull().default(0),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    // `job_id` joins the key so usage is attributable to the operation that
    // caused it. Aggregation is unaffected: every consumer sums over a day or a
    // month, and a SUM does not care how many rows it spans.
    uniqueIndex("search_usage_ledger_day_endpoint_idx").on(
      table.day,
      table.endpointPath,
      table.meteringClass,
      table.jobId,
    ),
    index("search_usage_ledger_day_idx").on(table.day),
    index("search_usage_ledger_job_idx").on(table.jobId),
  ],
);

/**
 * Rolled-up budget state per billing month, plus the circuit breaker. Kept
 * separate from the ledger so a spend decision is one indexed read rather than
 * an aggregate over the month.
 */
export const searchBudgetState = sqliteTable("search_budget_state", {
  /** Billing month, YYYY-MM. Primary key: one row per month. */
  month: text("month").primaryKey(),
  monthlyCostMicros: integer("monthly_cost_micros").notNull().default(0),
  /** Day the daily counter refers to; a different day resets it. */
  currentDay: text("current_day"),
  dailyCostMicros: integer("daily_cost_micros").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  circuitOpenedAt: text("circuit_opened_at"),
  /** Highest alert threshold already announced this month (70/85/95/100). */
  lastAlertThreshold: integer("last_alert_threshold"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});
