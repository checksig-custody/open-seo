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
 * Morgana Search Intelligence — phase 5 AI Visibility schema (Postgres mirror).
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Split from the Site Audit tables purely for size; the rules stated there
 * apply here too, and the one that matters most on this surface is that an
 * unavailable value stays null. Mention, citation and organic presence are
 * three separate columns because they are three separate claims.
 */

/**
 * The AI Visibility watchlist.
 *
 * Separate from the phase-2 keyword watchlist on purpose: these are questions a
 * person asks an assistant, not keywords we rank for, and mixing them would
 * make both lists wrong. Seeded from configuration, never hardcoded in logic.
 */
export const siAiVisibilityQueries = pgTable(
  "si_ai_visibility_queries",
  {
    id: text("id").primaryKey(),
    query: text("query").notNull(),
    normalizedQuery: text("normalized_query").notNull(),
    cluster: text("cluster"),
    priority: text("priority", { enum: ["critical", "high", "normal", "low"] })
      .notNull()
      .default("normal"),
    locationCode: integer("location_code").notNull().default(2380),
    languageCode: text("language_code").notNull().default("it"),
    enabled: boolean("enabled").notNull().default(true),
    checkIntervalHours: integer("check_interval_hours").notNull().default(168),
    lastCheckedAt: text("last_checked_at"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_ai_visibility_queries_identity_idx").on(
      table.normalizedQuery,
      table.locationCode,
      table.languageCode,
    ),
    index("si_ai_visibility_queries_enabled_idx").on(
      table.enabled,
      table.priority,
    ),
  ],
);

/**
 * One observation of one query.
 *
 * `primary_brand_mentioned` and `primary_brand_cited` are separate columns
 * because they are separate claims: being named in an answer is not being
 * linked as a source, and reporting one as the other would overstate what we
 * actually know. Both are nullable — "we did not observe" is a third state.
 */
export const siAiVisibilitySnapshots = pgTable(
  "si_ai_visibility_snapshots",
  {
    id: text("id").primaryKey(),
    queryId: text("query_id").notNull(),
    provider: text("provider").notNull(),
    engine: text("engine").notNull(),
    checkedAt: text("checked_at").notNull(),
    /** Did the SERP carry an AI answer at all? Null = not observed. */
    aiResultPresent: boolean("ai_result_present"),
    primaryBrandMentioned: boolean("primary_brand_mentioned"),
    primaryBrandCited: boolean("primary_brand_cited"),
    /** Null, never 0, when the answer could not be inspected. */
    competitorMentions: integer("competitor_mentions"),
    competitorCitations: integer("competitor_citations"),
    citedDomainCount: integer("cited_domain_count"),
    /** Where the brand appeared organically, for the third distinct fact. */
    organicPosition: integer("organic_position"),
    source: text("source", { enum: ["dataforseo", "fixture"] }).notNull(),
    providerStatus: text("provider_status").notNull().default("not_configured"),
    comparisonStatus: text("comparison_status", {
      enum: ["complete", "partial", "not_comparable"],
    })
      .notNull()
      .default("not_comparable"),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    providerRequestId: text("provider_request_id"),
    /** query + day + engine: one observation per query per engine per day. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_ai_visibility_snapshots_dedupe_idx").on(table.dedupeKey),
    index("si_ai_visibility_snapshots_query_idx").on(
      table.queryId,
      table.checkedAt,
    ),
  ],
);

/** A domain cited as a source by an AI answer. */
export const siAiVisibilityCitations = pgTable(
  "si_ai_visibility_citations",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id").notNull(),
    queryId: text("query_id").notNull(),
    domain: text("domain").notNull(),
    /** Lowercased, punycode, no www. The join key to entities and the graph. */
    normalizedDomain: text("normalized_domain").notNull(),
    url: text("url"),
    /** Set when the domain matches a configured entity; null otherwise. */
    entityId: text("entity_id"),
    citationOrder: integer("citation_order").notNull().default(0),
    title: text("title"),
    firstSeenAt: text("first_seen_at").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_ai_visibility_citations_dedupe_idx").on(table.dedupeKey),
    index("si_ai_visibility_citations_domain_idx").on(
      table.normalizedDomain,
      table.firstSeenAt,
    ),
    index("si_ai_visibility_citations_snapshot_idx").on(table.snapshotId),
  ],
);

/** Changes worth telling someone about. Detection is separate from delivery. */
export const siAiVisibilityEvents = pgTable(
  "si_ai_visibility_events",
  {
    id: text("id").primaryKey(),
    queryId: text("query_id").notNull(),
    eventType: text("event_type", {
      enum: [
        "citation_gained",
        "citation_lost",
        "competitor_citation_gained",
        "competitor_citation_lost",
        "ai_result_appeared",
        "ai_result_disappeared",
        "suspicious_domain_cited",
        "citation_share_change",
      ],
    }).notNull(),
    severity: text("severity", {
      enum: ["info", "notice", "warning", "critical"],
    })
      .notNull()
      .default("info"),
    domain: text("domain"),
    /** Null when the magnitude is genuinely unknown. */
    magnitude: real("magnitude"),
    reason: text("reason").notNull(),
    channel: text("channel", {
      enum: ["intel", "brand_protection", "security", "none"],
    })
      .notNull()
      .default("none"),
    deliveryStatus: text("delivery_status", {
      enum: ["detected", "delivered", "suppressed"],
    })
      .notNull()
      .default("detected"),
    deliveredAt: text("delivered_at"),
    suppressionReason: text("suppression_reason"),
    occurredAt: text("occurred_at").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_ai_visibility_events_dedupe_idx").on(table.dedupeKey),
    index("si_ai_visibility_events_delivery_idx").on(
      table.deliveryStatus,
      table.channel,
    ),
  ],
);
