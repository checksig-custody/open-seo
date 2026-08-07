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
    /**
     * WHAT THIS RESERVATION AUTHORISED, not merely how much it may cost.
     *
     * Without these two a reservation can be summed but not audited: the row
     * says "backlinks, 100 000 µUSD" and nothing else, so which domain was
     * bought and how many rows were asked for is only recoverable by guessing
     * from timestamps. `subject` is the target the operation ran against
     * (a domain for backlinks, a keyword for a SERP task); `subjectScope` is
     * the size of the question asked — the sample limit — because cost scales
     * with rows and an estimate is only checkable against the sample it
     * assumed. Both nullable: an operation that has no meaningful target says
     * so rather than inventing one.
     */
    subject: text("subject"),
    subjectScope: integer("subject_scope"),
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
        /** Resolved against provider evidence by a named human. */
        "resolved",
      ],
    })
      .notNull()
      .default("reserved"),
    /**
     * THE EXIT FROM `reconciliation_pending`, and what it cost to take it.
     *
     * Separate from `actual_cost_micros` on purpose: that column is what the
     * provider reported at the time, and overwriting it would erase the
     * difference between "the provider said" and "a human went and checked".
     * A reconciliation is a second, later observation, and it should read as
     * one.
     *
     * `resolution_evidence` is what the figure rests on — an invoice line, a
     * dashboard export, a support ticket. `resolveReservation` refuses without
     * it, which is the entire reason the column exists: a reconciliation with
     * no source is a guess wearing a timestamp.
     */
    resolvedCostMicros: integer("resolved_cost_micros"),
    resolutionEvidence: text("resolution_evidence"),
    /** Opaque actor reference; never an email. */
    resolvedBy: text("resolved_by"),
    resolvedAt: text("resolved_at"),
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
