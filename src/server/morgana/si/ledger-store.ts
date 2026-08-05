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

interface RecordUsageInput {
  day: string;
  entityId?: string | null;
  endpointPath: string;
  meteringClass: MeteringClass;
  estimatedCostMicros?: number;
  actualCostMicros?: number;
  failed?: boolean;
  retry?: boolean;
  blockedByBudget?: boolean;
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
    entityId: input.entityId ?? null,
    endpointPath: input.endpointPath,
    meteringClass: input.meteringClass,
    requests: isCache ? 0 : 1,
    meteredRequests: metered,
    failedRequests: input.failed ? 1 : 0,
    retryRequests: input.retry ? 1 : 0,
    estimatedCostMicros: input.estimatedCostMicros ?? 0,
    actualCostMicros: input.actualCostMicros ?? 0,
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
      ],
      set: {
        requests: sql`${searchUsageLedger.requests} + ${values.requests}`,
        meteredRequests: sql`${searchUsageLedger.meteredRequests} + ${values.meteredRequests}`,
        failedRequests: sql`${searchUsageLedger.failedRequests} + ${values.failedRequests}`,
        retryRequests: sql`${searchUsageLedger.retryRequests} + ${values.retryRequests}`,
        estimatedCostMicros: sql`${searchUsageLedger.estimatedCostMicros} + ${values.estimatedCostMicros}`,
        actualCostMicros: sql`${searchUsageLedger.actualCostMicros} + ${values.actualCostMicros}`,
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

// NOTE: the budget WRITE path (accruing spend, tripping the breaker, recording an
// announced alert threshold) is deliberately absent. Nothing can call it: live
// collection is not implemented in phase 1, so there is no spend to accrue. It
// belongs with the live collector, and shipping it now would be unreachable code
// that knip is right to reject. The READ path above is used and tested.
