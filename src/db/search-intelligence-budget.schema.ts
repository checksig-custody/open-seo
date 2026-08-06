import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Capacity held against the global Search Intelligence budget.
 *
 * A reservation is what a concurrent collector can SEE. Reading four ledgers
 * tells you what has been spent; only a reservation tells you what is about to
 * be. Without one, two collectors read the same remainder and both proceed —
 * which is how 2026-08-06 ended at 0.21400 USD against a 0.20 cap.
 */
export const siBudgetReservations = sqliteTable(
  "si_budget_reservations",
  {
    id: text("id").primaryKey(),
    /** The lock. A retry of the same operation collides here. */
    idempotencyKey: text("idempotency_key").notNull(),
    collector: text("collector").notNull(),
    operationType: text("operation_type").notNull(),
    jobId: text("job_id"),
    operationId: text("operation_id"),
    /** The worst case, never an average: capacity is held against this. */
    estimatedMaxCostMicros: integer("estimated_max_cost_micros").notNull(),
    /** NULL while unknown — never 0, which would release capacity too early. */
    actualCostMicros: integer("actual_cost_micros"),
    costStatus: text("cost_status"),
    status: text("status", {
      enum: [
        "reserved",
        "committed",
        "released",
        "expired",
        "reconciliation_pending",
      ],
    })
      .notNull()
      .default("reserved"),
    /** Resolved once by the authority, so a row and a ledger cannot disagree. */
    budgetDay: text("budget_day").notNull(),
    budgetMonth: text("budget_month").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    committedAt: text("committed_at"),
    releasedAt: text("released_at"),
    /** A code and this engine's own words. Never provider text. */
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
