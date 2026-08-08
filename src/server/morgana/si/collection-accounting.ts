/**
 * Morgana Search Intelligence — the accounting record of one collection.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * ONE OBJECT, THREE CONSUMERS. The ledger, the job row and the collection's own
 * diagnostic outcome all describe the same operation, and before this they
 * derived their numbers separately: the ledger summed provider-reported costs
 * per call, the job was finished without any cost argument at all and defaulted
 * both money columns to zero, and the outcome summed the calls a second time
 * inline. The visible result in production was a job reading
 * `actual_cost_micros = 0` beside ledger rows reading 40440 — two records of one
 * operation that disagreed about whether it cost anything.
 *
 * The fix is not to teach the job how to add up costs. It is to compute the
 * total exactly once, here, and hand the same value to everything that reports
 * it. A second derivation is a second thing that can drift.
 */

/** What the provider said about the cost of one call. */
export type CostStatus = "reported" | "zero" | "not_reported";

/**
 * One provider call: which endpoint, and what it cost.
 *
 * Not exported — callers pass the collector's own call records, which are
 * structurally this, and never need to name the type.
 */
interface AccountedCall {
  endpointPath: string;
  cost: { micros: number | null; status: CostStatus };
}

/**
 * The accounting record of one collection.
 *
 * `estimatedCostMicros` equals `actualCostMicros` here, and that is a statement
 * rather than a shortcut: DataForSEO reports what it charged on the same
 * response that carries the data, so this collector never holds a pre-call
 * estimate that could differ. Inventing a separate estimate would mean
 * inventing a number.
 */
export interface CollectionAccounting {
  estimatedCostMicros: number;
  actualCostMicros: number;
  /** The provider's own figure, summed over the calls that reported one. */
  providerReportedCostMicros: number;
  costStatus: CostStatus;
  requests: number;
  meteredRequests: number;
  paidSubmissions: number;
  freeRequests: number;
}

/**
 * Read what the provider said one call cost.
 *
 * Shared so every collector reads a provider cost the same way. A value that is
 * not a finite non-negative number is a GAP, not a zero: `NaN` used to survive
 * from here to the ledger's `col + ?` binding, which D1 rejects, and the
 * observed result was a snapshot with real metrics beside no ledger row at all
 * — the record of money already spent, lost.
 */
export function readProviderCost(billing: { costUsd?: number } | undefined): {
  micros: number | null;
  status: CostStatus;
} {
  const usd = billing?.costUsd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    return { micros: null, status: "not_reported" };
  }
  const micros = Math.round(usd * 1_000_000);
  return { micros, status: micros === 0 ? "zero" : "reported" };
}

/** The zero record: no call was made, so nothing is owed and nothing is known. */
export const NO_CALLS: CollectionAccounting = {
  estimatedCostMicros: 0,
  actualCostMicros: 0,
  providerReportedCostMicros: 0,
  costStatus: "not_reported",
  requests: 0,
  meteredRequests: 0,
  paidSubmissions: 0,
  freeRequests: 0,
};

/**
 * Roll a collection's calls into one accounting record.
 *
 * THE ROLLED-UP `costStatus`, precisely:
 *
 * - `not_reported` — NO call reported a cost. The total is not a measurement of
 *   zero, it is an absence, and it must not be recorded as money.
 * - `zero`         — every call reported, and every one of them reported zero.
 *   That IS a measurement: the endpoints were free.
 * - `reported`     — at least one call reported a figure above zero.
 *
 * A collection where some calls reported and others did not rolls up as
 * `reported`, because the money that IS known is real and must be charged
 * against the budget. The gap does not disappear: per-call granularity lives in
 * the ledger's `cost_reported_requests` / `cost_not_reported_requests` counters,
 * which are written from these same calls.
 *
 * `NaN` cannot reach any field. A call's cost is `null` unless `readCost`
 * accepted it as a finite non-negative number, and a null contributes nothing
 * to the sum rather than poisoning it — the arithmetic never sees a non-number.
 */
export function accountFor(
  calls: readonly AccountedCall[],
  metering: { metered: boolean; paidSubmission: boolean },
): CollectionAccounting {
  if (calls.length === 0) return NO_CALLS;

  let total = 0;
  let reportedAny = false;
  let positiveAny = false;
  for (const call of calls) {
    if (call.cost.status === "not_reported") continue;
    reportedAny = true;
    // `?? 0` is safe only on this branch: a reported or zero status means
    // `readCost` produced a finite non-negative integer.
    const micros = call.cost.micros ?? 0;
    total += micros;
    if (micros > 0) positiveAny = true;
  }

  const costStatus: CostStatus = !reportedAny
    ? "not_reported"
    : positiveAny
      ? "reported"
      : "zero";

  const metered = metering.metered ? calls.length : 0;
  return {
    estimatedCostMicros: total,
    actualCostMicros: total,
    providerReportedCostMicros: total,
    costStatus,
    requests: calls.length,
    meteredRequests: metered,
    paidSubmissions: metering.paidSubmission ? calls.length : 0,
    freeRequests: calls.length - metered,
  };
}
