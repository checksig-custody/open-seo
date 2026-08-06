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

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Morgana Search Intelligence — phase 5 schema (Postgres mirror).
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Structural mirror of `src/db/search-intelligence-p5.schema.ts`. The rationale
 * for every table lives there and is deliberately not repeated here, so the two
 * files cannot end up disagreeing about why something exists.
 *
 * ORIGINAL HEADER FOLLOWS, ABRIDGED.
 *
 * Two subsystems, one migration, because they share the same rules:
 *
 * 1. **A partial observation is never a complete one.** An audit that stopped
 *    early carries `comparison_status = 'partial'` and a `stop_reason`, and the
 *    diff refuses to call anything resolved from it. Silence caused by a page
 *    budget must never read as a fixed problem.
 * 2. **An unavailable value stays null.** Not zero. This is why every AI
 *    Visibility count is nullable and why `ai_result_present` is a separate
 *    column from the counts hanging off it.
 * 3. **Mention, citation and organic presence are three different facts**, so
 *    they are three different columns and never collapse into one "visibility".
 *
 * Site Audit spends nothing with a provider: it reads pages we are allowed to
 * read, over a boundary that refuses everything else. Its ledger therefore
 * measures *our* cost — requests, bytes, duration — under its own cost centre.
 */

/**
 * One crawl of one entity.
 *
 * A run is resumable: the crawler processes a bounded batch per invocation
 * because a Worker request cannot hold a 500-page crawl open. `deadline_at` is
 * the wall clock the whole run must finish inside, independent of how many
 * batches it takes.
 */
export const siSiteAuditRuns = pgTable(
  "si_site_audit_runs",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    trigger: text("trigger", { enum: ["manual", "scheduled"] })
      .notNull()
      .default("scheduled"),
    requestedBy: text("requested_by"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    /** Hard wall clock for the whole run, set when it starts. */
    deadlineAt: text("deadline_at"),
    /**
     * Whether this run may be compared with the previous one.
     *
     * `partial` is the load-bearing value: a truncated crawl, an exhausted
     * budget or an unreachable domain all produce it, and the diff will not
     * mark anything resolved from a run that carries it.
     */
    comparisonStatus: text("comparison_status", {
      enum: ["complete", "partial", "not_comparable"],
    })
      .notNull()
      .default("not_comparable"),
    pageLimit: integer("page_limit").notNull().default(100),
    pagesDiscovered: integer("pages_discovered").notNull().default(0),
    pagesCrawled: integer("pages_crawled").notNull().default(0),
    pagesFailed: integer("pages_failed").notNull().default(0),
    pagesBlocked: integer("pages_blocked").notNull().default(0),
    issuesTotal: integer("issues_total").notNull().default(0),
    criticalCount: integer("critical_count").notNull().default(0),
    highCount: integer("high_count").notNull().default(0),
    mediumCount: integer("medium_count").notNull().default(0),
    lowCount: integer("low_count").notNull().default(0),
    infoCount: integer("info_count").notNull().default(0),
    /** Null until the run completes — an unfinished crawl has no health. */
    siteHealth: real("site_health"),
    /** Which scoring model produced `site_health`. Never implicit. */
    healthModelVersion: text("health_model_version"),
    truncated: boolean("truncated").notNull().default(false),
    stopReason: text("stop_reason", {
      enum: [
        "completed",
        "page_limit",
        "time_limit",
        "budget",
        "unreachable",
        "robots_denied",
        "error",
        "cancelled",
      ],
    }),
    sitemapStatus: text("sitemap_status", {
      enum: ["ok", "missing", "invalid", "not_checked"],
    })
      .notNull()
      .default("not_checked"),
    robotsStatus: text("robots_status", {
      enum: ["ok", "missing", "invalid", "not_checked"],
    })
      .notNull()
      .default("not_checked"),
    /** Operational, not monetary: bytes and milliseconds we spent ourselves. */
    bytesFetched: integer("bytes_fetched").notNull().default(0),
    requestsMade: integer("requests_made").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    lastError: text("last_error"),
    /** entity + day + trigger: two scheduled runs a day cannot both exist. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_site_audit_runs_dedupe_idx").on(table.dedupeKey),
    index("si_site_audit_runs_entity_idx").on(table.entityId, table.createdAt),
    index("si_site_audit_runs_status_idx").on(table.status, table.createdAt),
  ],
);

/**
 * The crawl queue, persisted.
 *
 * It lives in the database rather than in memory because a run spans several
 * Worker invocations; an in-process frontier would restart from the homepage on
 * every batch and never finish.
 */
export const siSiteAuditFrontier = pgTable(
  "si_site_audit_frontier",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    /** Canonical form. The identity for dedupe — never the raw href. */
    normalizedUrl: text("normalized_url").notNull(),
    depth: integer("depth").notNull().default(0),
    discoveredFrom: text("discovered_from"),
    discoverySource: text("discovery_source", {
      enum: ["seed", "sitemap", "link", "redirect"],
    })
      .notNull()
      .default("link"),
    state: text("state", {
      enum: ["pending", "in_progress", "done", "skipped", "blocked"],
    })
      .notNull()
      .default("pending"),
    /** Why a URL was never fetched. Rendered in Crawl Details, not hidden. */
    skipReason: text("skip_reason"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_site_audit_frontier_identity_idx").on(
      table.runId,
      table.normalizedUrl,
    ),
    index("si_site_audit_frontier_state_idx").on(
      table.runId,
      table.state,
      table.depth,
    ),
  ],
);

/** One crawled page. Metrics are per-page facts, never judgements. */
export const siSiteAuditPages = pgTable(
  "si_site_audit_pages",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    entityId: text("entity_id").notNull(),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    canonicalUrl: text("canonical_url"),
    /** Null when the request never produced a response at all. */
    statusCode: integer("status_code"),
    contentType: text("content_type"),
    responseTimeMs: integer("response_time_ms"),
    depth: integer("depth").notNull().default(0),
    title: text("title"),
    metaDescription: text("meta_description"),
    h1Count: integer("h1_count").notNull().default(0),
    firstH1: text("first_h1"),
    robotsDirective: text("robots_directive"),
    /** Derived from status + robots + canonical. Nullable while unknown. */
    indexable: boolean("indexable"),
    indexabilityReason: text("indexability_reason"),
    contentLength: integer("content_length"),
    /** Visible-text length, which is what "empty page" actually means. */
    textLength: integer("text_length"),
    internalLinkCount: integer("internal_link_count").notNull().default(0),
    externalLinkCount: integer("external_link_count").notNull().default(0),
    imageCount: integer("image_count").notNull().default(0),
    imagesMissingAlt: integer("images_missing_alt").notNull().default(0),
    /** Shingled fingerprint of the visible text: near-duplicate detection. */
    contentHash: text("content_hash"),
    redirectChainLength: integer("redirect_chain_length").notNull().default(0),
    finalUrl: text("final_url"),
    inSitemap: boolean("in_sitemap").notNull().default(false),
    fetchError: text("fetch_error"),
    crawledAt: text("crawled_at").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_site_audit_pages_identity_idx").on(
      table.runId,
      table.normalizedUrl,
    ),
    index("si_site_audit_pages_run_idx").on(table.runId, table.statusCode),
    index("si_site_audit_pages_hash_idx").on(table.runId, table.contentHash),
  ],
);

/** Internal link graph for the run — the source of orphan and depth checks. */
export const siSiteAuditLinks = pgTable(
  "si_site_audit_links",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    targetUrl: text("target_url").notNull(),
    /** Truncated: an anchor is evidence, not content to store in full. */
    anchorText: text("anchor_text"),
    linkType: text("link_type", { enum: ["internal", "external"] })
      .notNull()
      .default("internal"),
    rel: text("rel"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_site_audit_links_dedupe_idx").on(table.dedupeKey),
    index("si_site_audit_links_target_idx").on(table.runId, table.targetUrl),
  ],
);

/**
 * A detected problem.
 *
 * `first_seen_at` survives across runs for a persistent issue, which is what
 * makes "this has been broken for three weeks" answerable. `details` carries
 * the evidence the analyst needs to disagree with the classification.
 */
export const siSiteAuditIssues = pgTable(
  "si_site_audit_issues",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    entityId: text("entity_id").notNull(),
    pageId: text("page_id"),
    /** Present even when `page_id` is null (a site-level issue). */
    pageUrl: text("page_url"),
    issueType: text("issue_type").notNull(),
    category: text("category", {
      enum: ["crawl", "indexing", "metadata", "links", "images", "content"],
    }).notNull(),
    severity: text("severity", {
      enum: ["critical", "high", "medium", "low", "info"],
    })
      .notNull()
      .default("low"),
    status: text("status", {
      enum: ["open", "acknowledged", "ignored", "resolved"],
    })
      .notNull()
      .default("open"),
    /** JSON: the evidence. Rendered to the analyst, never summarised away. */
    details: text("details"),
    /** new | persistent | worsened | improved, decided by the diff. */
    changeState: text("change_state", {
      enum: ["new", "persistent", "worsened", "improved", "unknown"],
    })
      .notNull()
      .default("unknown"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    resolvedAt: text("resolved_at"),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
    /** run + issue type + page: one row per problem per page per run. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_site_audit_issues_dedupe_idx").on(table.dedupeKey),
    index("si_site_audit_issues_run_idx").on(
      table.runId,
      table.severity,
      table.issueType,
    ),
    index("si_site_audit_issues_entity_idx").on(
      table.entityId,
      table.issueType,
      table.status,
    ),
  ],
);

/** How an issue changed between two comparable runs. The audit trail of the diff. */
export const siSiteAuditIssueEvents = pgTable(
  "si_site_audit_issue_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    entityId: text("entity_id").notNull(),
    issueType: text("issue_type").notNull(),
    pageUrl: text("page_url"),
    eventType: text("event_type", {
      enum: ["new", "resolved", "worsened", "improved", "persistent"],
    }).notNull(),
    severity: text("severity", {
      enum: ["critical", "high", "medium", "low", "info"],
    })
      .notNull()
      .default("low"),
    previousRunId: text("previous_run_id"),
    /** Human-readable, and the reason a `resolved` event was allowed at all. */
    reason: text("reason").notNull(),
    occurredAt: text("occurred_at").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_site_audit_issue_events_dedupe_idx").on(table.dedupeKey),
    index("si_site_audit_issue_events_run_idx").on(
      table.runId,
      table.eventType,
    ),
  ],
);

/**
 * Site Audit's own ledger.
 *
 * The cost centre is `site_audit_internal` because nothing here is billed by a
 * provider — the numbers are requests, bytes and milliseconds we spent. Keeping
 * them in the same shape as the paid ledgers means one page can show what the
 * subsystem costs without pretending the units are dollars.
 */
export const siSiteAuditUsageLedger = pgTable(
  "si_site_audit_usage_ledger",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    entityId: text("entity_id"),
    runId: text("run_id"),
    requests: integer("requests").notNull().default(0),
    pagesProcessed: integer("pages_processed").notNull().default(0),
    bytesFetched: integer("bytes_fetched").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    blocked: integer("blocked").notNull().default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
    cacheMisses: integer("cache_misses").notNull().default(0),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_site_audit_usage_day_idx").on(
      table.day,
      table.entityId,
      table.runId,
    ),
  ],
);
