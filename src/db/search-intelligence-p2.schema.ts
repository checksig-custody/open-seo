import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { searchEntities } from "./search-intelligence.schema";

/**
 * Morgana Search Intelligence — phase 2 schema (SQLite/D1).
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Keyword watchlist, rank tracking, keyword gap and Tracked Keyword Share of
 * Search. Mirrored in `src/db/pg/search-intelligence-p2.schema.ts`;
 * `schema-parity.test.ts` fails the build if the two drift.
 *
 * Money stays integer micro-USD, as everywhere else.
 */

export const keywordClusters = sqliteTable(
  "keyword_clusters",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    /**
     * Multiplies a keyword's contribution to Share of Search. A brand cluster
     * matters more than a general-education one, and the weight is the honest
     * place to say so rather than hiding it inside a score.
     */
    weight: real("weight").notNull().default(1),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [uniqueIndex("keyword_clusters_slug_idx").on(table.slug)],
);

export const trackedKeywords = sqliteTable(
  "tracked_keywords",
  {
    id: text("id").primaryKey(),
    keyword: text("keyword").notNull(),
    /** Lowercased, whitespace-collapsed, accent-preserving. The match key. */
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
    /** Phase 2 is desktop only; the column exists so phase 3 needs no migration. */
    device: text("device", { enum: ["desktop", "mobile"] })
      .notNull()
      .default("desktop"),
    /** Hours between scheduled checks. Derived from priority at creation. */
    trackingFrequencyHours: integer("tracking_frequency_hours")
      .notNull()
      .default(168),
    trackingEnabled: integer("tracking_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    alertingEnabled: integer("alerting_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /** Provider search volume, refreshed opportunistically. Null until known. */
    searchVolume: integer("search_volume"),
    /**
     * Where this keyword came from: `bootstrap` for the seeded watchlist,
     * `manual` for one a human added. Kept so a re-runnable bootstrap can tell
     * its own rows apart from an operator's edits and never overwrite them.
     */
    createdSource: text("created_source").notNull().default("manual"),
    lastCheckedAt: text("last_checked_at"),
    nextCheckAt: text("next_check_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    disabledAt: text("disabled_at"),
  },
  (table) => [
    // One row per keyword per market. The same keyword in two markets is two
    // different tracking problems.
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

/**
 * One observed position, for one keyword, for one domain, at one time.
 *
 * A domain that does not appear is recorded with `isFound = false` and NULL
 * positions — never a sentinel like 101. A sentinel silently becomes a real
 * number in every average, delta and chart that touches it.
 */
export const siRankSnapshots = sqliteTable(
  "si_rank_snapshots",
  {
    id: text("id").primaryKey(),
    trackedKeywordId: text("tracked_keyword_id")
      .notNull()
      .references(() => trackedKeywords.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => searchEntities.id, { onDelete: "cascade" }),
    snapshotAt: text("snapshot_at").notNull(),
    /** UTC day bucket, for dedupe and for daily rollups. */
    snapshotDate: text("snapshot_date").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    /** Organic position as a human would say it. The one shown in the UI. */
    rankGroup: integer("rank_group"),
    /** Counts ads and SERP features. Kept separate, never conflated. */
    rankAbsolute: integer("rank_absolute"),
    rankingUrl: text("ranking_url"),
    normalizedRankingUrl: text("normalized_ranking_url"),
    isFound: integer("is_found", { mode: "boolean" }).notNull(),
    /** The host the ranking URL actually resolved to, after normalization. */
    rankingDomain: text("ranking_domain"),
    /**
     * The SERP element the position was read from — `organic` for the product's
     * ranking number. Stored so a rank can never later be confused with a
     * featured snippet or a local pack, which is a different claim entirely.
     */
    resultType: text("result_type"),
    /**
     * `complete` or `partial`. A partial observation is one the provider could
     * not fully answer, and it must never be read as a measurement: in
     * particular it can never confirm a lost ranking.
     */
    snapshotStatus: text("snapshot_status", { enum: ["complete", "partial"] })
      .notNull()
      .default("complete"),
    /** Why it is partial, when it is. Sanitised; never provider text. */
    snapshotStatusReason: text("snapshot_status_reason"),
    /** The queued task this observation came from — accounting correlation. */
    providerTaskId: text("provider_task_id"),
    provider: text("provider", { enum: ["dataforseo", "fixture"] }).notNull(),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    /** `keyword|entity|date` — one observation per pair per day. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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

/** A computed gap classification for one keyword at one point in time. */
export const keywordGapSnapshots = sqliteTable(
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
    /** Simple, explainable: volume × gap size. Never an opaque composite. */
    opportunityScore: real("opportunity_score"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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

export const shareOfSearchSnapshots = sqliteTable(
  "share_of_search_snapshots",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => searchEntities.id, { onDelete: "cascade" }),
    /** Null means "all clusters". */
    clusterId: text("cluster_id"),
    snapshotDate: text("snapshot_date").notNull(),
    visibilityScore: real("visibility_score"),
    /** 0..1. Null when coverage was too thin to answer honestly. */
    share: real("share"),
    status: text("status", { enum: ["ok", "insufficient_data"] }).notNull(),
    reason: text("reason"),
    keywordsConsidered: integer("keywords_considered").notNull().default(0),
    keywordsCovered: integer("keywords_covered").notNull().default(0),
    /** Which CTR curve produced this number. Changing the curve changes history. */
    ctrModelVersion: text("ctr_model_version").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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

/** A detected, alert-worthy ranking change. One row per emitted event. */
export const rankingEvents = sqliteTable(
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
    detectedAt: text("detected_at").notNull(),
    /** `keyword|entity|type|date` — the cooldown and dedupe key. */
    dedupeKey: text("dedupe_key").notNull(),
    notifiedAt: text("notified_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ranking_events_dedupe_idx").on(table.dedupeKey),
    index("ranking_events_detected_idx").on(table.detectedAt),
  ],
);

export const rankingJobs = sqliteTable(
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
    scheduledAt: text("scheduled_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    skipReason: text("skip_reason"),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
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

/**
 * Phase-2 usage, kept separate from the phase-1 ledger so rank tracking's
 * consumption is attributable on its own.
 *
 * `httpRequests` and `paidTasks` are distinct columns because one DataForSEO
 * `task_post` can carry up to 100 keywords: counting HTTP calls would badly
 * understate spend, and counting keywords would badly overstate it.
 */
export const phase2UsageLedger = sqliteTable(
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
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("phase2_usage_ledger_day_job_idx").on(table.day, table.jobType),
  ],
);

/**
 * The lifecycle of one DataForSEO SERP task, persisted.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * WHY A TABLE AND NOT A PROMISE. A queued SERP is charged when it is POSTED and
 * answered some seconds to minutes later, by a second, free call. Waiting for
 * it inside the request that submitted it would hold a Worker invocation open
 * across a provider queue, and losing that invocation — a deploy, a timeout, a
 * subrequest ceiling — would lose the only record that money had been spent.
 *
 * So the submission and the collection are separate operations joined by a row.
 * `provider_task_id` is what makes the paid work recoverable: as long as it is
 * stored, the result can be fetched by any later invocation, and no retry can
 * turn into a second paid submission.
 *
 * `next_check_at` is the backoff, held here rather than in a scheduler's head,
 * so a restart does not stampede every pending task at once.
 */
export const siRankTasks = sqliteTable(
  "si_rank_tasks",
  {
    id: text("id").primaryKey(),
    /** The rank-check job this task belongs to; the accounting correlation id. */
    jobId: text("job_id"),
    trackedKeywordId: text("tracked_keyword_id")
      .notNull()
      .references(() => trackedKeywords.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => searchEntities.id, { onDelete: "cascade" }),
    /**
     * DataForSEO's own id for the queued task. Null only between deciding to
     * submit and the provider answering; once set it is never overwritten,
     * because it is the receipt for a call that has already been billed.
     */
    providerTaskId: text("provider_task_id"),
    keyword: text("keyword").notNull(),
    targetDomain: text("target_domain").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    searchEngine: text("search_engine").notNull().default("google"),
    /**
     * The collection window this task belongs to (a UTC day). Part of the
     * dedupe key: "already asked today" is the question that decides whether a
     * second paid submission is allowed.
     */
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
        // Local polling gave up; the provider task may still be alive and the
        // receipt is still valid. Recoverable by explicit request only.
        "recovery_pending",
        "failed",
      ],
    }).notNull(),
    /** `keyword|entity|window|location|language|device|engine`. */
    dedupeKey: text("dedupe_key").notNull(),
    submittedAt: text("submitted_at"),
    /** When a fetch may next be attempted — the persisted backoff. */
    nextCheckAt: text("next_check_at"),
    lastCheckedAt: text("last_checked_at"),
    completedAt: text("completed_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    /** Where a failure came from, using the phase 1 taxonomy. */
    errorOrigin: text("error_origin"),
    errorClass: text("error_class"),
    errorCode: text("error_code"),
    /** The endpoint actually in flight when it failed. */
    endpoint: text("endpoint"),
    snapshotId: text("snapshot_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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
