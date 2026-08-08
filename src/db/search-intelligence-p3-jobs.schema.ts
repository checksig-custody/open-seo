import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Morgana Search Intelligence — phase 3: backlink jobs and the derived gap.
 *
 * Split out of `search-intelligence-p3.schema.ts` because that file had grown
 * past the repository's module size limit, and these two tables are the natural
 * seam: everything left there records what the provider SAID about links, and
 * everything here records what this engine DID with it — a job's lifecycle, and
 * the cross-entity gap recomputed from the stored samples.
 *
 * Re-exported through `@/db/schema`, which is how every consumer reaches them,
 * so the move is invisible outside this directory. No column changed and no
 * migration was regenerated: this is a TypeScript reorganisation only.
 */

/** Backlink refresh jobs, kept separate from the phase-2 rank jobs. */
export const siBacklinkJobs = sqliteTable(
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
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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
export const siBacklinkGapSnapshots = sqliteTable(
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
    linksPrimary: integer("links_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    competitorCount: integer("competitor_count").notNull().default(0),
    domainRank: integer("domain_rank"),
    spamScore: integer("spam_score"),
    riskClassification: text("risk_classification", {
      enum: ["low", "review", "suspicious", "high_risk"],
    }),
    /** Null when quality signals are unknown — never a fabricated zero. */
    opportunityScore: real("opportunity_score"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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
