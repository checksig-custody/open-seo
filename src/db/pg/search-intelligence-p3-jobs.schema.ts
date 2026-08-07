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
 * Postgres mirror of the phase-3 job and gap tables.
 *
 * Split from `search-intelligence-p3.schema.ts` for the same reason as its D1
 * twin, along the same seam, so the two dialects stay symmetrical.
 */

// Duplicated from the sibling schema rather than imported from it: these two
// files are peers under one barrel, and an import between them would put a
// dependency exactly where the split was meant to remove one.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

/** Backlink refresh jobs, kept separate from the phase-2 rank jobs. */
export const siBacklinkJobs = pgTable(
  "si_backlink_jobs",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id"),
    jobType: text("job_type", {
      enum: [
        "backlink_overview_refresh",
        "backlink_detail_refresh",
        "backlink_comparison",
        "backlink_risk_recalculate",
        "backlink_alert_delivery",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed", "skipped"],
    })
      .notNull()
      .default("pending"),
    trigger: text("trigger", { enum: ["scheduled", "manual"] })
      .notNull()
      .default("scheduled"),
    priority: integer("priority").notNull().default(50),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    startedAt: timestampColumn("started_at"),
    finishedAt: timestampColumn("finished_at"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    operationId: text("operation_id"),
    /** What this job spent, without joining the ledger through a timestamp. */
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    costStatus: text("cost_status"),
    errorOrigin: text("error_origin"),
    errorClass: text("error_class"),
    errorCode: text("error_code"),
    endpoint: text("endpoint"),
  },
  (table) => [
    uniqueIndex("si_backlink_jobs_dedupe_idx").on(table.dedupeKey),
    index("si_backlink_jobs_status_idx").on(table.status, table.priority),
  ],
);

/** Cross-entity referring-domain gap, recomputed per comparison run. */
export const siBacklinkGapSnapshots = pgTable(
  "si_backlink_gap_snapshots",
  {
    id: text("id").primaryKey(),
    normalizedDomain: text("normalized_domain").notNull(),
    domain: text("domain").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    category: text("category", {
      enum: [
        "shared",
        "primary_only",
        "competitor_only",
        "multi_competitor_only",
        "new_opportunity",
      ],
    }).notNull(),
    /** JSON array of competitor entity ids this domain links to. */
    competitorEntityIds: text("competitor_entity_ids").notNull().default("[]"),
    linksPrimary: boolean("links_primary").notNull().default(false),
    competitorCount: integer("competitor_count").notNull().default(0),
    domainRank: integer("domain_rank"),
    spamScore: integer("spam_score"),
    riskClassification: text("risk_classification", {
      enum: ["low", "review", "suspicious", "high_risk"],
    }),
    /** Null when quality signals are unknown — never a fabricated zero. */
    opportunityScore: real("opportunity_score"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    datasetCoverage: real("dataset_coverage"),
    sampleLimit: integer("sample_limit"),
    exclusionReasons: text("exclusion_reasons"),
    calculatedAt: text("calculated_at"),
  },
  (table) => [
    uniqueIndex("si_backlink_gap_dedupe_idx").on(
      table.normalizedDomain,
      table.snapshotDate,
    ),
    index("si_backlink_gap_category_idx").on(
      table.snapshotDate,
      table.category,
    ),
  ],
);
