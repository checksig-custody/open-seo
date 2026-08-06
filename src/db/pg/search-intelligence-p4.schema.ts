import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Morgana Search Intelligence — phase 4 schema (Postgres mirror).
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Structural mirror of `src/db/search-intelligence-p4.schema.ts`. Rationale for
 * each table lives there and is not repeated, so the two cannot disagree.
 */

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

/**
 * Nodes.
 *
 * `canonical_value` is the identity: a normalized domain, a normalized keyword,
 * a canonical URL. Two observations of the same thing from different systems
 * must collapse onto one node, and this column is what makes that true.
 */
export const siGraphNodes = pgTable(
  "si_graph_nodes",
  {
    id: text("id").primaryKey(),
    nodeType: text("node_type", {
      enum: [
        "brand",
        "competitor",
        "domain",
        "page",
        "keyword",
        "mention",
        "article",
        "backlink",
        "referring_domain",
        "telegram_channel",
        "social_profile",
        "campaign",
        "finding",
        // Phase 5 subjects. Drizzle enforces the enum in TypeScript only, so
        // extending it needs no DDL — the column stays plain text.
        "audit_page",
        "audit_issue",
        "ai_query",
        "cited_domain",
      ],
    }).notNull(),
    /** Identifier in the system of record. Never a copy of that record. */
    externalId: text("external_id"),
    /** Which system owns the referenced record. */
    sourceSystem: text("source_system", {
      enum: ["morgana", "search_intelligence", "derived"],
    })
      .notNull()
      .default("derived"),
    label: text("label").notNull(),
    /** The dedupe identity: normalized domain, keyword, URL, channel handle. */
    canonicalValue: text("canonical_value").notNull(),
    /** JSON. Small, denormalised display hints only — never the source record. */
    metadata: text("metadata"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    /** How many times this node has been observed. Drives graph pruning. */
    observationCount: integer("observation_count").notNull().default(1),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_graph_nodes_identity_idx").on(
      table.nodeType,
      table.canonicalValue,
    ),
    index("si_graph_nodes_type_idx").on(table.nodeType, table.lastSeenAt),
    index("si_graph_nodes_external_idx").on(
      table.sourceSystem,
      table.externalId,
    ),
  ],
);

/**
 * Edges.
 *
 * `weight` is how strong the relationship is; `confidence` is how sure we are
 * that it exists at all. They are different questions and conflating them is
 * how a graph starts asserting things it cannot support — a single weak
 * observation and a hundred consistent ones must not look alike.
 */
export const siGraphEdges = pgTable(
  "si_graph_edges",
  {
    id: text("id").primaryKey(),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    edgeType: text("edge_type", {
      enum: [
        "MENTIONS",
        "RANKS_FOR",
        "LINKS_TO",
        "PUBLISHED",
        "REFERS_TO",
        "COMPETES_WITH",
        "IMPERSONATES",
        "ASSOCIATED_WITH",
        "PART_OF_CAMPAIGN",
        "TRIGGERED_FINDING",
        // Phase 5 relationships.
        "HAS_AUDIT_ISSUE",
        "CITES",
        "MENTIONS_IN_AI_RESULT",
        "REFERENCES_PAGE",
      ],
    }).notNull(),
    weight: real("weight").notNull().default(1),
    /** Null until enough evidence exists to state one. Never a default 0. */
    confidence: real("confidence"),
    evidenceCount: integer("evidence_count").notNull().default(1),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    metadata: text("metadata"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_graph_edges_identity_idx").on(
      table.sourceNodeId,
      table.targetNodeId,
      table.edgeType,
    ),
    // Indexed in both directions: a bounded walk expands from either end, and
    // without the reverse index every hop would be a table scan.
    index("si_graph_edges_out_idx").on(table.sourceNodeId, table.edgeType),
    index("si_graph_edges_in_idx").on(table.targetNodeId, table.edgeType),
  ],
);

/** Why we believe an edge, a campaign or a finding. Never summarised away. */
export const siGraphEvidence = pgTable(
  "si_graph_evidence",
  {
    id: text("id").primaryKey(),
    /** What this evidence supports. */
    subjectType: text("subject_type", {
      enum: ["edge", "campaign", "finding"],
    }).notNull(),
    subjectId: text("subject_id").notNull(),
    evidenceType: text("evidence_type").notNull(),
    /** Id in the system of record, so an analyst can go and look. */
    sourceRecordId: text("source_record_id"),
    sourceSystem: text("source_system", {
      enum: ["morgana", "search_intelligence", "derived"],
    }).notNull(),
    observedAt: text("observed_at").notNull(),
    weight: real("weight").notNull().default(1),
    /** Human-readable. Rendered verbatim to the analyst. */
    reason: text("reason").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_graph_evidence_dedupe_idx").on(table.dedupeKey),
    index("si_graph_evidence_subject_idx").on(
      table.subjectType,
      table.subjectId,
    ),
  ],
);

/**
 * Detected campaigns.
 *
 * A campaign needs at least three coherent signals in one window. One signal is
 * noise; two is a coincidence; three is the point at which it is worth someone
 * looking. That threshold is the entire anti-noise mechanism here.
 */
export const siCampaigns = pgTable(
  "si_campaigns",
  {
    id: text("id").primaryKey(),
    category: text("category", {
      enum: [
        "brand_campaign",
        "competitor_campaign",
        "content_campaign",
        "link_building_campaign",
        "possible_impersonation_campaign",
        "unknown_campaign",
      ],
    }).notNull(),
    /** The entity the campaign is about — ours or a competitor's. */
    subjectEntityId: text("subject_entity_id"),
    subjectLabel: text("subject_label").notNull(),
    startAt: text("start_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    windowDays: integer("window_days").notNull().default(7),
    signalCount: integer("signal_count").notNull().default(0),
    /** Null while the evidence is too thin to state one. */
    confidence: real("confidence"),
    status: text("status", {
      enum: ["candidate", "active", "confirmed", "ended", "dismissed"],
    })
      .notNull()
      .default("candidate"),
    /** JSON array of graph node ids the campaign touches. */
    entities: text("entities").notNull().default("[]"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: text("reviewed_at"),
    reviewNote: text("review_note"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_campaigns_dedupe_idx").on(table.dedupeKey),
    index("si_campaigns_status_idx").on(table.status, table.lastActivityAt),
  ],
);

/** The individual signals a campaign was built from, kept separately. */
export const siCampaignSignals = pgTable(
  "si_campaign_signals",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id").notNull(),
    signalType: text("signal_type", {
      enum: [
        "mention_surge",
        "new_pages",
        "new_keywords",
        "ranking_gains",
        "new_backlinks",
        "new_referring_domains",
        "new_landing_pages",
        "social_spike",
        "coordinated_anchors",
        "linked_domains",
      ],
    }).notNull(),
    /** Null when the magnitude is genuinely unknown — never a stand-in zero. */
    magnitude: real("magnitude"),
    observedAt: text("observed_at").notNull(),
    reason: text("reason").notNull(),
    /** Signal families, for the independence rule. */
    family: text("family").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_campaign_signals_dedupe_idx").on(table.dedupeKey),
    index("si_campaign_signals_campaign_idx").on(table.campaignId),
  ],
);

/** Reputation incidents: independent signals converging on one subject. */
export const siReputationFindings = pgTable(
  "si_reputation_findings",
  {
    id: text("id").primaryKey(),
    category: text("category", {
      enum: [
        "negative_content_rising",
        "brand_confusion",
        "possible_impersonation",
        "coordinated_negative_mentions",
        "suspicious_domain_campaign",
        "competitor_reputation_event",
      ],
    }).notNull(),
    severity: text("severity", { enum: ["low", "medium", "high", "critical"] })
      .notNull()
      .default("low"),
    confidence: real("confidence"),
    /** JSON array of `{ type, family, reason, weight }`. */
    signals: text("signals").notNull().default("[]"),
    /** JSON array of graph node ids. */
    affectedEntities: text("affected_entities").notNull().default("[]"),
    subjectLabel: text("subject_label").notNull(),
    /** How many independent signal FAMILIES fired. Gates the loud channel. */
    independentFamilies: integer("independent_families").notNull().default(0),
    /** Where this belongs, decided at detection rather than at send time. */
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
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    status: text("status", {
      enum: ["new", "reviewing", "confirmed", "dismissed", "resolved"],
    })
      .notNull()
      .default("new"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: text("reviewed_at"),
    reviewNote: text("review_note"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_reputation_findings_dedupe_idx").on(table.dedupeKey),
    index("si_reputation_findings_status_idx").on(table.status, table.severity),
    index("si_reputation_findings_delivery_idx").on(
      table.deliveryStatus,
      table.channel,
    ),
  ],
);

/**
 * The unified timeline.
 *
 * Denormalised on purpose: it is a read model assembled from six sources, and
 * assembling it per request would mean six queries and a merge on every page
 * load. The dedupe key is what stops the same underlying fact appearing twice
 * because two different views reported it.
 */
export const siTimelineEvents = pgTable(
  "si_timeline_events",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull(),
    eventType: text("event_type", {
      enum: [
        "mention",
        "ranking_change",
        "keyword_new",
        "keyword_lost",
        "backlink_new",
        "backlink_lost",
        "campaign_event",
        "finding",
        "sentiment_change",
        "competitor_event",
      ],
    }).notNull(),
    /** Graph node the event belongs to, when there is one. */
    entityNodeId: text("entity_node_id"),
    entityLabel: text("entity_label").notNull(),
    summary: text("summary").notNull(),
    severity: text("severity", {
      enum: ["info", "notice", "warning", "critical"],
    })
      .notNull()
      .default("info"),
    sourceSystem: text("source_system", {
      enum: ["morgana", "search_intelligence", "derived"],
    }).notNull(),
    sourceRecordId: text("source_record_id"),
    /** Where an analyst can go to see the underlying record. */
    evidenceRef: text("evidence_ref"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_timeline_events_dedupe_idx").on(table.dedupeKey),
    index("si_timeline_events_time_idx").on(table.occurredAt),
    index("si_timeline_events_type_idx").on(table.eventType, table.occurredAt),
    index("si_timeline_events_entity_idx").on(
      table.entityNodeId,
      table.occurredAt,
    ),
  ],
);

/**
 * Incremental ingestion cursors.
 *
 * The reason the correlation tick is affordable at all: each source is read
 * from where it stopped rather than from the beginning. A full rebuild on every
 * tick would be both slow and, for Morgana's mention table, unbounded.
 */
export const siCorrelationCheckpoints = pgTable(
  "si_correlation_checkpoints",
  {
    id: text("id").primaryKey(),
    /** e.g. `morgana_mentions`, `si_rank_snapshots`, `si_backlinks`. */
    sourceKey: text("source_key").notNull(),
    /** Opaque cursor — an ISO timestamp or a record id, source's choice. */
    cursor: text("cursor"),
    lastRunAt: text("last_run_at"),
    lastRunStatus: text("last_run_status", {
      enum: ["ok", "partial", "failed"],
    }),
    recordsProcessed: integer("records_processed").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("si_correlation_checkpoints_source_idx").on(table.sourceKey),
  ],
);
