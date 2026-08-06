import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Morgana Search Intelligence — phase 1 schema (Postgres mirror).
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Structural mirror of `src/db/search-intelligence.schema.ts`. This file is the
 * one artifact `db:generate` does NOT regenerate, so `schema-parity.test.ts` is
 * its drift guard: same tables, columns, nullability, defaults and unique
 * indexes, or the build fails.
 *
 * See the SQLite file for the rationale behind each table — it is not repeated
 * here, so the two cannot disagree about intent.
 */

// Timestamps are text in both dialects (see app.schema.ts for why: timestamptz
// would be parsed back into a Date and break lexicographic comparisons).
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

export const searchEntities = pgTable(
  "search_entities",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    canonicalDomain: text("canonical_domain").notNull(),
    normalizedDomain: text("normalized_domain").notNull(),
    entityType: text("entity_type", {
      enum: ["primary", "competitor", "watch"],
    }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priority: text("priority", { enum: ["high", "normal", "low"] })
      .notNull()
      .default("normal"),
    includeSubdomains: boolean("include_subdomains").notNull().default(false),
    locationCode: integer("location_code").notNull().default(2380),
    languageCode: text("language_code").notNull().default("it"),
    refreshIntervalHours: integer("refresh_interval_hours")
      .notNull()
      .default(24),
    backlinkIntervalHours: integer("backlink_interval_hours")
      .notNull()
      .default(168),
    lastRefreshedAt: timestampColumn("last_refreshed_at"),
    lastBacklinkRefreshedAt: timestampColumn("last_backlink_refreshed_at"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
    disabledAt: timestampColumn("disabled_at"),
  },
  (table) => [
    uniqueIndex("search_entities_domain_market_idx").on(
      table.normalizedDomain,
      table.locationCode,
      table.languageCode,
    ),
    index("search_entities_enabled_idx").on(table.enabled, table.entityType),
  ],
);

export const domainSnapshots = pgTable(
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
    rankSignal: integer("rank_signal"),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    source: text("source", { enum: ["dataforseo", "fixture"] }).notNull(),
    providerRequestId: text("provider_request_id"),
    fetchedAt: timestampColumn("fetched_at").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("domain_snapshots_dedupe_idx").on(table.dedupeKey),
    index("domain_snapshots_entity_date_idx").on(
      table.entityId,
      table.snapshotDate,
    ),
  ],
);

export const domainSnapshotKeywords = pgTable(
  "domain_snapshot_keywords",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => domainSnapshots.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    rankGroup: integer("rank_group"),
    rankAbsolute: integer("rank_absolute"),
    searchVolume: integer("search_volume"),
    estimatedTraffic: real("estimated_traffic"),
    cpc: real("cpc"),
    keywordDifficulty: integer("keyword_difficulty"),
    searchIntent: text("search_intent"),
    rankingUrl: text("ranking_url"),
    serpUpdatedAt: timestampColumn("serp_updated_at"),
    position: integer("position").notNull(),
  },
  (table) => [
    index("domain_snapshot_keywords_snapshot_idx").on(
      table.snapshotId,
      table.position,
    ),
  ],
);

export const domainSnapshotPages = pgTable(
  "domain_snapshot_pages",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => domainSnapshots.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    estimatedTraffic: real("estimated_traffic"),
    keywordCount: integer("keyword_count"),
    topKeyword: text("top_keyword"),
    topKeywordPosition: integer("top_keyword_position"),
    pageTitle: text("page_title"),
    lastSeenAt: timestampColumn("last_seen_at"),
    position: integer("position").notNull(),
  },
  (table) => [
    index("domain_snapshot_pages_snapshot_idx").on(
      table.snapshotId,
      table.position,
    ),
  ],
);

export const domainRefreshJobs = pgTable(
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
    requestedBy: text("requested_by"),
    dedupeKey: text("dedupe_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    skipReason: text("skip_reason"),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    costStatus: text("cost_status", {
      enum: ["reported", "zero", "not_reported"],
    }),
    snapshotId: text("snapshot_id"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    startedAt: timestampColumn("started_at"),
    finishedAt: timestampColumn("finished_at"),
  },
  (table) => [
    uniqueIndex("domain_refresh_jobs_dedupe_idx").on(table.dedupeKey),
    index("domain_refresh_jobs_status_idx").on(table.status, table.createdAt),
    index("domain_refresh_jobs_entity_idx").on(table.entityId, table.createdAt),
  ],
);

export const searchUsageLedger = pgTable(
  "search_usage_ledger",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    entityId: text("entity_id"),
    jobId: text("job_id").notNull().default(""),
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
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    costReportedRequests: integer("cost_reported_requests")
      .notNull()
      .default(0),
    costNotReportedRequests: integer("cost_not_reported_requests")
      .notNull()
      .default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
    cacheMisses: integer("cache_misses").notNull().default(0),
    blockedByBudget: integer("blocked_by_budget").notNull().default(0),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
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

export const searchBudgetState = pgTable("search_budget_state", {
  month: text("month").primaryKey(),
  monthlyCostMicros: integer("monthly_cost_micros").notNull().default(0),
  currentDay: text("current_day"),
  dailyCostMicros: integer("daily_cost_micros").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  circuitOpenedAt: timestampColumn("circuit_opened_at"),
  lastAlertThreshold: integer("last_alert_threshold"),
  updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
});
