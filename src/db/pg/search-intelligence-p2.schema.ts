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
import { searchEntities } from "./search-intelligence.schema";

/**
 * Morgana Search Intelligence — phase 2 schema (Postgres mirror).
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Structural mirror of `src/db/search-intelligence-p2.schema.ts`. Rationale for
 * each table lives there and is not repeated, so the two cannot disagree.
 */

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

export const keywordClusters = pgTable(
  "keyword_clusters",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    weight: real("weight").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [uniqueIndex("keyword_clusters_slug_idx").on(table.slug)],
);

export const trackedKeywords = pgTable(
  "tracked_keywords",
  {
    id: text("id").primaryKey(),
    keyword: text("keyword").notNull(),
    normalizedKeyword: text("normalized_keyword").notNull(),
    clusterId: text("cluster_id").references(() => keywordClusters.id, {
      onDelete: "set null",
    }),
    priority: text("priority", {
      enum: ["critical", "high", "normal", "low"],
    })
      .notNull()
      .default("normal"),
    locationCode: integer("location_code").notNull().default(2380),
    languageCode: text("language_code").notNull().default("it"),
    device: text("device", { enum: ["desktop", "mobile"] })
      .notNull()
      .default("desktop"),
    trackingFrequencyHours: integer("tracking_frequency_hours")
      .notNull()
      .default(168),
    trackingEnabled: boolean("tracking_enabled").notNull().default(true),
    alertingEnabled: boolean("alerting_enabled").notNull().default(true),
    searchVolume: integer("search_volume"),
    createdSource: text("created_source").notNull().default("manual"),
    lastCheckedAt: timestampColumn("last_checked_at"),
    nextCheckAt: timestampColumn("next_check_at"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
    disabledAt: timestampColumn("disabled_at"),
  },
  (table) => [
    uniqueIndex("tracked_keywords_keyword_market_idx").on(
      table.normalizedKeyword,
      table.locationCode,
      table.languageCode,
      table.device,
    ),
    index("tracked_keywords_due_idx").on(
      table.trackingEnabled,
      table.nextCheckAt,
    ),
    index("tracked_keywords_cluster_idx").on(table.clusterId),
  ],
);

export const siRankSnapshots = pgTable(
  "si_rank_snapshots",
  {
    id: text("id").primaryKey(),
    trackedKeywordId: text("tracked_keyword_id")
      .notNull()
      .references(() => trackedKeywords.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => searchEntities.id, { onDelete: "cascade" }),
    snapshotAt: timestampColumn("snapshot_at").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    rankGroup: integer("rank_group"),
    rankAbsolute: integer("rank_absolute"),
    rankingUrl: text("ranking_url"),
    normalizedRankingUrl: text("normalized_ranking_url"),
    isFound: boolean("is_found").notNull(),
    rankingDomain: text("ranking_domain"),
    resultType: text("result_type"),
    snapshotStatus: text("snapshot_status", { enum: ["complete", "partial"] })
      .notNull()
      .default("complete"),
    snapshotStatusReason: text("snapshot_status_reason"),
    providerTaskId: text("provider_task_id"),
    provider: text("provider", { enum: ["dataforseo", "fixture"] }).notNull(),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_rank_snapshots_dedupe_idx").on(table.dedupeKey),
    index("si_rank_snapshots_keyword_date_idx").on(
      table.trackedKeywordId,
      table.snapshotDate,
    ),
    index("si_rank_snapshots_entity_date_idx").on(
      table.entityId,
      table.snapshotDate,
    ),
  ],
);

export const keywordGapSnapshots = pgTable(
  "keyword_gap_snapshots",
  {
    id: text("id").primaryKey(),
    trackedKeywordId: text("tracked_keyword_id")
      .notNull()
      .references(() => trackedKeywords.id, { onDelete: "cascade" }),
    snapshotDate: text("snapshot_date").notNull(),
    category: text("category", {
      enum: [
        "shared",
        "primary_only",
        "competitor_only",
        "missing",
        "weak",
        "strong",
        "new",
        "lost",
        "improved",
        "declined",
      ],
    }).notNull(),
    primaryRank: integer("primary_rank"),
    bestCompetitorRank: integer("best_competitor_rank"),
    bestCompetitorEntityId: text("best_competitor_entity_id"),
    opportunityScore: real("opportunity_score"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("keyword_gap_snapshots_dedupe_idx").on(
      table.trackedKeywordId,
      table.snapshotDate,
    ),
    index("keyword_gap_snapshots_date_idx").on(
      table.snapshotDate,
      table.category,
    ),
  ],
);

export const shareOfSearchSnapshots = pgTable(
  "share_of_search_snapshots",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => searchEntities.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id"),
    snapshotDate: text("snapshot_date").notNull(),
    visibilityScore: real("visibility_score"),
    share: real("share"),
    status: text("status", { enum: ["ok", "insufficient_data"] }).notNull(),
    reason: text("reason"),
    keywordsConsidered: integer("keywords_considered").notNull().default(0),
    keywordsCovered: integer("keywords_covered").notNull().default(0),
    ctrModelVersion: text("ctr_model_version").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("share_of_search_dedupe_idx").on(
      table.entityId,
      table.clusterId,
      table.snapshotDate,
    ),
    index("share_of_search_date_idx").on(table.snapshotDate),
  ],
);

export const rankingEvents = pgTable(
  "ranking_events",
  {
    id: text("id").primaryKey(),
    trackedKeywordId: text("tracked_keyword_id").notNull(),
    entityId: text("entity_id").notNull(),
    eventType: text("event_type", {
      enum: [
        "entered_top_3",
        "entered_top_10",
        "left_top_10",
        "dropped_10_plus",
        "gained_10_plus",
        "overtaken_by_competitor",
        "overtook_competitors",
        "critical_keyword_lost",
        "share_of_search_shift",
      ],
    }).notNull(),
    previousRank: integer("previous_rank"),
    currentRank: integer("current_rank"),
    competitorEntityId: text("competitor_entity_id"),
    rankingUrl: text("ranking_url"),
    detectedAt: timestampColumn("detected_at").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    notifiedAt: timestampColumn("notified_at"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("ranking_events_dedupe_idx").on(table.dedupeKey),
    index("ranking_events_detected_idx").on(table.detectedAt),
  ],
);

export const rankingJobs = pgTable(
  "ranking_jobs",
  {
    id: text("id").primaryKey(),
    jobType: text("job_type", {
      enum: [
        "rank_check",
        "keyword_gap_refresh",
        "share_of_search_recalculate",
        "weekly_digest",
      ],
    }).notNull(),
    trackedKeywordId: text("tracked_keyword_id"),
    priority: text("priority", {
      enum: ["critical", "high", "normal", "low"],
    })
      .notNull()
      .default("normal"),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed", "skipped"],
    }).notNull(),
    scheduledAt: timestampColumn("scheduled_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    skipReason: text("skip_reason"),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    startedAt: timestampColumn("started_at"),
    finishedAt: timestampColumn("finished_at"),
  },
  (table) => [
    uniqueIndex("ranking_jobs_dedupe_idx").on(table.dedupeKey),
    index("ranking_jobs_queue_idx").on(
      table.status,
      table.priority,
      table.scheduledAt,
    ),
  ],
);

export const phase2UsageLedger = pgTable(
  "phase2_usage_ledger",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    jobType: text("job_type").notNull(),
    httpRequests: integer("http_requests").notNull().default(0),
    meteredRequests: integer("metered_requests").notNull().default(0),
    paidTasks: integer("paid_tasks").notNull().default(0),
    keywordsChecked: integer("keywords_checked").notNull().default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
    cacheMisses: integer("cache_misses").notNull().default(0),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    blockedByBudget: integer("blocked_by_budget").notNull().default(0),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("phase2_usage_ledger_day_job_idx").on(table.day, table.jobType),
  ],
);

export const siRankTasks = pgTable(
  "si_rank_tasks",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id"),
    trackedKeywordId: text("tracked_keyword_id")
      .notNull()
      .references(() => trackedKeywords.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => searchEntities.id, { onDelete: "cascade" }),
    providerTaskId: text("provider_task_id"),
    keyword: text("keyword").notNull(),
    targetDomain: text("target_domain").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    searchEngine: text("search_engine").notNull().default("google"),
    collectionWindow: text("collection_window").notNull(),
    status: text("status", {
      enum: [
        "queued",
        "submitting",
        "submitted",
        "waiting",
        "ready",
        "fetching",
        "normalizing",
        "succeeded",
        "skipped",
        "failed",
      ],
    }).notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    submittedAt: timestampColumn("submitted_at"),
    nextCheckAt: timestampColumn("next_check_at"),
    lastCheckedAt: timestampColumn("last_checked_at"),
    completedAt: timestampColumn("completed_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    errorOrigin: text("error_origin"),
    errorClass: text("error_class"),
    errorCode: text("error_code"),
    endpoint: text("endpoint"),
    snapshotId: text("snapshot_id"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_rank_tasks_dedupe_idx").on(table.dedupeKey),
    index("si_rank_tasks_status_idx").on(table.status, table.nextCheckAt),
    index("si_rank_tasks_provider_idx").on(table.providerTaskId),
    index("si_rank_tasks_keyword_idx").on(
      table.trackedKeywordId,
      table.collectionWindow,
    ),
  ],
);
