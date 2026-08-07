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
 * Morgana Search Intelligence — phase 3 schema (Postgres mirror).
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Structural mirror of `src/db/search-intelligence-p3.schema.ts`. Rationale for
 * each table lives there and is not repeated, so the two cannot disagree.
 */

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

/** Observed backlinks, one row per (source URL, target URL, anchor, type). */
export const siBacklinks = pgTable(
  "si_backlinks",
  {
    id: text("id").primaryKey(),
    /** The entity this backlink points AT — the one whose profile it belongs to. */
    targetEntityId: text("target_entity_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    normalizedSourceUrl: text("normalized_source_url").notNull(),
    sourceDomain: text("source_domain").notNull(),
    normalizedSourceDomain: text("normalized_source_domain").notNull(),
    targetUrl: text("target_url").notNull(),
    normalizedTargetUrl: text("normalized_target_url").notNull(),
    /** Null when the link carries no anchor. Never an empty string. */
    anchorText: text("anchor_text"),
    normalizedAnchor: text("normalized_anchor"),
    linkType: text("link_type").notNull().default("unknown"),
    isDofollow: boolean("is_dofollow"),
    isNofollow: boolean("is_nofollow"),
    firstSeenAt: timestampColumn("first_seen_at").notNull(),
    lastSeenAt: timestampColumn("last_seen_at").notNull(),
    lostAt: timestampColumn("lost_at"),
    /**
     * `unknown` is a real state, not a placeholder: it is what a partial or
     * budget-truncated snapshot leaves behind, and it must never be reported
     * as a loss.
     */
    status: text("status", { enum: ["active", "lost", "unknown"] })
      .notNull()
      .default("active"),
    provider: text("provider").notNull().default("fixture"),
    providerBacklinkId: text("provider_backlink_id"),
    domainRank: integer("domain_rank"),
    pageRank: integer("page_rank"),
    spamScore: integer("spam_score"),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    /** Stable identity across retries, pagination and concurrent snapshots. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
    source: text("source").notNull().default("fixture"),
    sourceMainDomain: text("source_main_domain"),
    targetDomain: text("target_domain"),
    backlinkType: text("backlink_type"),
    isBroken: boolean("is_broken"),
    language: text("language"),
    /** The sampled collection this row came from. */
    snapshotId: text("snapshot_id"),
  },
  (table) => [
    uniqueIndex("si_backlinks_dedupe_idx").on(table.dedupeKey),
    index("si_backlinks_target_idx").on(table.targetEntityId, table.status),
    index("si_backlinks_domain_idx").on(table.normalizedSourceDomain),
    index("si_backlinks_seen_idx").on(table.targetEntityId, table.lastSeenAt),
  ],
);

/** One row per completed collection pass over an entity's backlink profile. */
export const siBacklinkSnapshots = pgTable(
  "si_backlink_snapshots",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull(),
    snapshotAt: timestampColumn("snapshot_at").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    backlinkCount: integer("backlink_count"),
    referringDomainCount: integer("referring_domain_count"),
    dofollowCount: integer("dofollow_count"),
    nofollowCount: integer("nofollow_count"),
    newBacklinks: integer("new_backlinks"),
    lostBacklinks: integer("lost_backlinks"),
    newReferringDomains: integer("new_referring_domains"),
    lostReferringDomains: integer("lost_referring_domains"),
    /**
     * The single most important column here. A `partial` snapshot means the
     * page cap, the budget or a provider timeout cut collection short, so the
     * absence of a backlink proves nothing and no loss may be derived from it.
     */
    comparisonStatus: text("comparison_status", {
      enum: ["complete", "partial", "not_comparable"],
    })
      .notNull()
      .default("not_comparable"),
    comparisonReason: text("comparison_reason"),
    backlinksProcessed: integer("backlinks_processed").notNull().default(0),
    domainsProcessed: integer("domains_processed").notNull().default(0),
    provider: text("provider").notNull().default("fixture"),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    /** `dataforseo` or `fixture`. The question an export needs to answer. */
    source: text("source").notNull().default("fixture"),
    /** `complete` / `partial` / `no_data` — three different provider answers. */
    snapshotStatus: text("snapshot_status").notNull().default("complete"),
    snapshotStatusReason: text("snapshot_status_reason"),
    /** THE SAMPLE, STATED. A backlink absent from 100 sampled rows of a
     * 10,000-row profile has not been lost; it has not been looked at. */
    sampleLimit: integer("sample_limit"),
    sampleOffset: integer("sample_offset"),
    /** Sampled / reported total. Null when the provider states no total. */
    datasetCoverage: real("dataset_coverage"),
    reportedBacklinkTotal: integer("reported_backlink_total"),
    reportedReferringDomainTotal: integer("reported_referring_domain_total"),
    /** The request shape, so only like-for-like snapshots are compared. */
    datasetSignature: text("dataset_signature"),
    costStatus: text("cost_status"),
    providerReportedCostMicros: integer("provider_reported_cost_micros"),
    jobId: text("job_id"),
    operationId: text("operation_id"),
  },
  (table) => [
    uniqueIndex("si_backlink_snapshots_dedupe_idx").on(table.dedupeKey),
    index("si_backlink_snapshots_entity_idx").on(
      table.entityId,
      table.snapshotDate,
    ),
  ],
);

/** Referring domains, aggregated per entity. */
export const siReferringDomains = pgTable(
  "si_referring_domains",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull(),
    domain: text("domain").notNull(),
    normalizedDomain: text("normalized_domain").notNull(),
    firstSeenAt: timestampColumn("first_seen_at").notNull(),
    lastSeenAt: timestampColumn("last_seen_at").notNull(),
    lostAt: timestampColumn("lost_at"),
    backlinkCount: integer("backlink_count"),
    targetPageCount: integer("target_page_count"),
    domainRank: integer("domain_rank"),
    spamScore: integer("spam_score"),
    country: text("country"),
    tld: text("tld"),
    status: text("status", { enum: ["active", "lost", "unknown"] })
      .notNull()
      .default("active"),
    riskClassification: text("risk_classification", {
      enum: ["low", "review", "suspicious", "high_risk"],
    }),
    riskScore: integer("risk_score"),
    /** JSON array of `{ component, weight, reason, evidence }`. */
    riskReasons: text("risk_reasons"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
    source: text("source").notNull().default("fixture"),
    referringMainDomain: text("referring_main_domain"),
    dofollowCount: integer("dofollow_count"),
    nofollowCount: integer("nofollow_count"),
    language: text("language"),
  },
  (table) => [
    uniqueIndex("si_referring_domains_dedupe_idx").on(
      table.entityId,
      table.normalizedDomain,
    ),
    index("si_referring_domains_status_idx").on(table.entityId, table.status),
    index("si_referring_domains_risk_idx").on(table.riskClassification),
  ],
);

/** Anchor text aggregates, one row per (entity, anchor, snapshot date). */
export const siAnchorSnapshots = pgTable(
  "si_anchor_snapshots",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull(),
    /** Null for a link with no anchor — a real and interesting case. */
    anchorText: text("anchor_text"),
    normalizedAnchor: text("normalized_anchor").notNull(),
    category: text("category", {
      enum: [
        "brand",
        "brand_variant",
        "exact_keyword",
        "partial_keyword",
        "url",
        "generic",
        "empty",
        "suspicious",
        "unknown",
      ],
    })
      .notNull()
      .default("unknown"),
    backlinkCount: integer("backlink_count").notNull().default(0),
    referringDomainCount: integer("referring_domain_count")
      .notNull()
      .default(0),
    firstSeenAt: timestampColumn("first_seen_at").notNull(),
    lastSeenAt: timestampColumn("last_seen_at").notNull(),
    snapshotAt: timestampColumn("snapshot_at").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    suspiciousSignal: text("suspicious_signal"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    dofollowCount: integer("dofollow_count"),
    nofollowCount: integer("nofollow_count"),
    /** Share of the SAMPLE. Null when the denominator is unknown. */
    sharePercent: real("share_percent"),
  },
  (table) => [
    uniqueIndex("si_anchor_snapshots_dedupe_idx").on(
      table.entityId,
      table.normalizedAnchor,
      table.snapshotDate,
    ),
    index("si_anchor_snapshots_entity_idx").on(
      table.entityId,
      table.snapshotDate,
    ),
  ],
);

/**
 * Backlink events, including the suspicious-finding review workflow.
 *
 * Findings and ordinary events share a table because they share a lifecycle:
 * detected, deduplicated, delivered, and — for the ones that matter — reviewed.
 */
export const siBacklinkEvents = pgTable(
  "si_backlink_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type", {
      enum: [
        "backlink_gained",
        "backlink_lost",
        "referring_domain_gained",
        "referring_domain_lost",
        "competitor_domain_gained",
        "backlink_gap_opportunity",
        "anomalous_growth",
        "suspicious_link",
        "possible_impersonation",
      ],
    }).notNull(),
    entityId: text("entity_id").notNull(),
    backlinkId: text("backlink_id"),
    referringDomainId: text("referring_domain_id"),
    /** The domain the event is about; the grouping key for alert cooldown. */
    subjectDomain: text("subject_domain"),
    severity: text("severity", {
      enum: ["info", "notice", "warning", "critical"],
    })
      .notNull()
      .default("info"),
    /** Which Slack surface this belongs on. Decided at detection, not at send. */
    channel: text("channel", {
      enum: ["intel", "brand_protection", "security", "none"],
    })
      .notNull()
      .default("intel"),
    status: text("status", { enum: ["detected", "delivered", "suppressed"] })
      .notNull()
      .default("detected"),
    riskScore: integer("risk_score"),
    riskClassification: text("risk_classification", {
      enum: ["low", "review", "suspicious", "high_risk"],
    }),
    /** JSON array of explainable reasons. Rendered to the analyst verbatim. */
    reasons: text("reasons"),
    /** JSON summary from Morgana's brand-protection signal adapter. */
    brandProtectionSignals: text("brand_protection_signals"),
    brandProtectionStatus: text("brand_protection_status")
      .notNull()
      .default("no_known_signal"),
    detectedAt: timestampColumn("detected_at").notNull(),
    confirmedAt: timestampColumn("confirmed_at"),
    deliveredAt: timestampColumn("delivered_at"),
    suppressionReason: text("suppression_reason"),
    // --- minimal review workflow ---
    reviewStatus: text("review_status", {
      enum: [
        "new",
        "reviewing",
        "confirmed_benign",
        "confirmed_suspicious",
        "escalated",
        "dismissed",
      ],
    })
      .notNull()
      .default("new"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestampColumn("reviewed_at"),
    reviewNote: text("review_note"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_backlink_events_dedupe_idx").on(table.dedupeKey),
    index("si_backlink_events_entity_idx").on(table.entityId, table.detectedAt),
    index("si_backlink_events_review_idx").on(
      table.reviewStatus,
      table.riskClassification,
    ),
    index("si_backlink_events_delivery_idx").on(table.status, table.channel),
  ],
);

/** Phase-3 usage ledger. Its own cost centre, per the phase-2 lesson. */
export const siBacklinkUsageLedger = pgTable(
  "si_backlink_usage_ledger",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    entityId: text("entity_id"),
    endpointPath: text("endpoint_path").notNull(),
    /** Free lifecycle calls increment `requests` but never `meteredRequests`. */
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
    paidTasks: integer("paid_tasks").notNull().default(0),
    resultFetchRequests: integer("result_fetch_requests").notNull().default(0),
    backlinksProcessed: integer("backlinks_processed").notNull().default(0),
    domainsProcessed: integer("domains_processed").notNull().default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
    cacheMisses: integer("cache_misses").notNull().default(0),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
    costStatus: text("cost_status"),
    providerReportedCostMicros: integer("provider_reported_cost_micros"),
    freeRequests: integer("free_requests").notNull().default(0),
    /** Empty string, not NULL: SQLite treats NULLs as distinct in a unique
     * index, which is how the phase-1 ledger stopped deduplicating. */
    jobId: text("job_id").notNull().default(""),
    operationId: text("operation_id").notNull().default(""),
  },
  (table) => [
    uniqueIndex("si_backlink_usage_dedupe_idx").on(
      table.day,
      table.entityId,
      table.endpointPath,
      table.meteringClass,
    ),
  ],
);
