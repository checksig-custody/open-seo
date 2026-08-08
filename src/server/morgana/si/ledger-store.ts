import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { searchBudgetState, searchUsageLedger } from "@/db/schema";
import { isMetered, type MeteringClass } from "./budget";
import { newId, nowIso } from "./ids";

/**
 * Morgana Search Intelligence — usage ledger and budget state.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Split out of store.ts to stay inside the repo's 400-line module limit, and
 * because the accounting surface has a different reason to change from the
 * entity and snapshot surface.
 */

// --- usage ledger and budget state -----------------------------------------

/**
 * What the provider said about the cost of a call.
 *
 * `zero` and `not_reported` are different facts and must stay different: the
 * first is a measurement ("this endpoint was free"), the second is a gap ("we
 * never learned"). Collapsing them makes a silent under-report indistinguishable
 * from a real zero, which is the one way a budget guard can be wrong without
 * anybody noticing.
 */
type CostStatus = "reported" | "zero" | "not_reported";

/**
 * Which collector is spending. Three of them share this ledger.
 *
 * Required, not defaulted: a default would silently attribute the next
 * collector's money to whichever centre happened to be written first, which is
 * exactly how ranking spend spent a week reported as Domain Overview.
 */
type LedgerCostCentre =
  | "domain_overview"
  | "ranking"
  | "keyword_volume"
  | "ai_visibility";

interface RecordUsageInput {
  day: string;
  costCentre: LedgerCostCentre;
  entityId?: string | null;
  /**
   * The refresh job that caused this call — the correlation id that lets
   * "what did this job cost" be answered from the ledger rather than inferred
   * from a timestamp or a domain. Absent for usage with no job, which is stored
   * as `''` because a NULL would break the unique index this row upserts on.
   */
  jobId?: string | null;
  endpointPath: string;
  meteringClass: MeteringClass;
  estimatedCostMicros?: number;
  /**
   * Only meaningful when `costStatus` is `reported` or `zero`. A cost that was
   * not reported must not arrive here as 0 — pass `costStatus: "not_reported"`
   * and leave this undefined.
   */
  actualCostMicros?: number;
  costStatus?: CostStatus;
  failed?: boolean;
  retry?: boolean;
  blockedByBudget?: boolean;
}

/** Reject anything that is not a finite, non-negative integer of micro-USD. */
function safeCostMicros(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value);
}

/**
 * Record one call against the ledger.
 *
 * `requests` always increments; `metered_requests` only for classes that
 * actually consume an allowance. That separation is the whole point (decision
 * #84): free lifecycle polls must never ration paid work.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const metered = isMetered(input.meteringClass) ? 1 : 0;
  const isCache = input.meteringClass === "cache";
  const values = {
    id: newId("ul"),
    day: input.day,
    costCentre: input.costCentre,
    entityId: input.entityId ?? null,
    jobId: input.jobId ?? "",
    endpointPath: input.endpointPath,
    meteringClass: input.meteringClass,
    requests: isCache ? 0 : 1,
    meteredRequests: metered,
    failedRequests: input.failed ? 1 : 0,
    retryRequests: input.retry ? 1 : 0,
    estimatedCostMicros: safeCostMicros(input.estimatedCostMicros),
    // A not-reported cost contributes NOTHING to the money column. It is
    // counted below instead, so the gap stays visible rather than being
    // silently rounded into a zero.
    actualCostMicros:
      input.costStatus === "not_reported"
        ? 0
        : safeCostMicros(input.actualCostMicros),
    costReportedRequests:
      input.costStatus === "reported" || input.costStatus === "zero" ? 1 : 0,
    costNotReportedRequests: input.costStatus === "not_reported" ? 1 : 0,
    cacheHits: isCache ? 1 : 0,
    cacheMisses: isCache ? 0 : 1,
    blockedByBudget: input.blockedByBudget ? 1 : 0,
    updatedAt: nowIso(),
  };
  await db
    .insert(searchUsageLedger)
    .values(values)
    .onConflictDoUpdate({
      target: [
        searchUsageLedger.day,
        searchUsageLedger.endpointPath,
        searchUsageLedger.meteringClass,
        searchUsageLedger.jobId,
      ],
      set: {
        requests: sql`${searchUsageLedger.requests} + ${values.requests}`,
        meteredRequests: sql`${searchUsageLedger.meteredRequests} + ${values.meteredRequests}`,
        failedRequests: sql`${searchUsageLedger.failedRequests} + ${values.failedRequests}`,
        retryRequests: sql`${searchUsageLedger.retryRequests} + ${values.retryRequests}`,
        estimatedCostMicros: sql`${searchUsageLedger.estimatedCostMicros} + ${values.estimatedCostMicros}`,
        actualCostMicros: sql`${searchUsageLedger.actualCostMicros} + ${values.actualCostMicros}`,
        costReportedRequests: sql`${searchUsageLedger.costReportedRequests} + ${values.costReportedRequests}`,
        costNotReportedRequests: sql`${searchUsageLedger.costNotReportedRequests} + ${values.costNotReportedRequests}`,
        cacheHits: sql`${searchUsageLedger.cacheHits} + ${values.cacheHits}`,
        cacheMisses: sql`${searchUsageLedger.cacheMisses} + ${values.cacheMisses}`,
        blockedByBudget: sql`${searchUsageLedger.blockedByBudget} + ${values.blockedByBudget}`,
        updatedAt: values.updatedAt,
      },
    });
}

interface LedgerTotals {
  requests: number;
  meteredRequests: number;
  paidSubmissions: number;
  freePollRequests: number;
  resultFetchRequests: number;
  failedRequests: number;
  retryRequests: number;
  estimatedCostMicros: number;
  actualCostMicros: number;
  cacheHits: number;
  cacheMisses: number;
  blockedByBudget: number;
}

const ZERO_TOTALS: LedgerTotals = {
  requests: 0,
  meteredRequests: 0,
  paidSubmissions: 0,
  freePollRequests: 0,
  resultFetchRequests: 0,
  failedRequests: 0,
  retryRequests: 0,
  estimatedCostMicros: 0,
  actualCostMicros: 0,
  cacheHits: 0,
  cacheMisses: 0,
  blockedByBudget: 0,
};

/** Ledger totals for a month (`YYYY-MM`) or a single day (`YYYY-MM-DD`). */
export async function ledgerTotals(prefix: string): Promise<LedgerTotals> {
  const rows = await db
    .select()
    .from(searchUsageLedger)
    .where(sql`${searchUsageLedger.day} LIKE ${`${prefix}%`}`);
  const totals: LedgerTotals = { ...ZERO_TOTALS };
  for (const row of rows) {
    totals.requests += row.requests;
    totals.meteredRequests += row.meteredRequests;
    totals.failedRequests += row.failedRequests;
    totals.retryRequests += row.retryRequests;
    totals.estimatedCostMicros += row.estimatedCostMicros;
    totals.actualCostMicros += row.actualCostMicros;
    totals.cacheHits += row.cacheHits;
    totals.cacheMisses += row.cacheMisses;
    totals.blockedByBudget += row.blockedByBudget;
    if (row.meteringClass === "paid_submission")
      totals.paidSubmissions += row.requests;
    if (row.meteringClass === "free_poll")
      totals.freePollRequests += row.requests;
    if (row.meteringClass === "result_fetch")
      totals.resultFetchRequests += row.requests;
  }
  return totals;
}

type BudgetStateRow = typeof searchBudgetState.$inferSelect;

export async function readBudgetState(month: string): Promise<BudgetStateRow> {
  const rows = await db
    .select()
    .from(searchBudgetState)
    .where(eq(searchBudgetState.month, month))
    .limit(1);
  const row = rows[0];
  return (
    row ?? {
      month,
      monthlyCostMicros: 0,
      currentDay: null,
      dailyCostMicros: 0,
      consecutiveFailures: 0,
      circuitOpenedAt: null,
      lastAlertThreshold: null,
    }
  );
}

// NOTE: `search_budget_state` still has no WRITE path for SPEND, and that is now
// deliberate rather than pending. The live collector records every call in the
// usage ledger, and `ledgerTotals` derives the day and month spend from those
// rows, so the budget guard reads the same numbers that were written when the
// money was spent. A second accrued copy would be a dual write with nothing to
// reconcile it, and the failure mode of a drifting budget copy is a cap that
// silently stops binding.
//
// The state row survives for the circuit breaker, which is real state: how many
// consecutive failures have happened, and when the breaker opened. Neither is
// derivable from usage.
