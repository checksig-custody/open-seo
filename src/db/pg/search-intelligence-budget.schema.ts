import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Postgres mirror of the global budget reservations (see the D1 schema). */
export const siBudgetReservations = pgTable(
  "si_budget_reservations",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    collector: text("collector").notNull(),
    operationType: text("operation_type").notNull(),
    jobId: text("job_id"),
    operationId: text("operation_id"),
    subject: text("subject"),
    subjectScope: integer("subject_scope"),
    estimatedMaxCostMicros: integer("estimated_max_cost_micros").notNull(),
    actualCostMicros: integer("actual_cost_micros"),
    costStatus: text("cost_status"),
    status: text("status", {
      enum: [
        "reserved",
        "committed",
        "released",
        "expired",
        "reconciliation_pending",
        "resolved",
      ],
    })
      .notNull()
      .default("reserved"),
    resolvedCostMicros: integer("resolved_cost_micros"),
    resolutionEvidence: text("resolution_evidence"),
    resolvedBy: text("resolved_by"),
    resolvedAt: text("resolved_at"),
    budgetDay: text("budget_day").notNull(),
    budgetMonth: text("budget_month").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    committedAt: text("committed_at"),
    releasedAt: text("released_at"),
    failureReason: text("failure_reason"),
  },
  (table) => [
    uniqueIndex("si_budget_reservations_idempotency_idx").on(
      table.idempotencyKey,
    ),
    index("si_budget_reservations_day_idx").on(table.budgetDay, table.status),
    index("si_budget_reservations_month_idx").on(
      table.budgetMonth,
      table.status,
    ),
    index("si_budget_reservations_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

/** Postgres mirror of the latched provider state (see the D1 schema). */
export const siProviderState = pgTable("si_provider_state", {
  provider: text("provider").primaryKey(),
  state: text("state").notNull(),
  detectedAt: text("detected_at").notNull(),
  lastCheckedAt: text("last_checked_at"),
  clearedAt: text("cleared_at"),
  clearReason: text("clear_reason"),
  clearedBy: text("cleared_by"),
  endpoint: text("endpoint"),
  operationType: text("operation_type"),
  providerStatusCode: integer("provider_status_code"),
  sanitizedMessage: text("sanitized_message"),
  jobId: text("job_id"),
  operationId: text("operation_id"),
  requiresAttention: boolean("requires_attention").notNull().default(false),
  credentialGeneration: text("credential_generation"),
  updatedAt: text("updated_at").notNull(),
});
