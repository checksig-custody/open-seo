import { type Phase0Config, isEnabled } from "./phase0-env";
import { detectMeteredWhileDisabled } from "./phase0-guard";

/**
 * Morgana Search Intelligence — Phase 0 cost centre.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P4).
 *
 * `dataforseo_search_intelligence` is a cost centre wholly separate from
 * Morgana's `dataforseo_brand_monitoring`. The separation is structural, not
 * merely logical: this engine is a different Worker, with a different secret
 * store, a different D1 and a different DataForSEO credential. Exhausting the
 * credit, revoking the key or tripping the breaker here cannot reach Brand
 * Monitoring's code path at all.
 *
 * Money is integer micro-USD end to end (Morgana decision #3). USD floats
 * appear only at the presentation boundary, in `toUsd()`.
 */

export const SEARCH_INTELLIGENCE_COST_CENTRE = "dataforseo_search_intelligence";
export const BRAND_MONITORING_COST_CENTRE = "dataforseo_brand_monitoring";

export type DataForSeoStatus =
  | "disabled"
  | "not_configured"
  | "configured_but_paid_calls_disabled"
  | "configured";

export type CostLedger = {
  cost_centre: string;
  requests: number;
  metered_requests: number;
  free_requests: number;
  paid_submissions: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
  daily_cost_cap_usd: number;
  monthly_cost_cap_usd: number;
  budget_remaining_usd: number;
  projected_month_end_cost_usd: number;
  cache_hits: number;
  cache_misses: number;
  blocked_by_budget: number;
  /** Critical incident flag: paid calls off, yet something was metered. */
  unexpected_spend_detected: boolean;
};

function toUsd(micros: number): number {
  return Math.round(micros) / 1_000_000;
}

/**
 * Resolve the DataForSEO configuration state.
 *
 * `not_configured` is a first-class, non-failing Phase-0 state: the engine's
 * dedicated credential is expected to be absent until Phase 1, and its absence
 * must not make the engine unready.
 */
export function resolveDataForSeoStatus(
  config: Phase0Config,
  credentialPresent: boolean,
): DataForSeoStatus {
  if (!isEnabled(config.SEARCH_INTELLIGENCE_ENABLED)) {
    return "disabled";
  }
  if (!credentialPresent) {
    return "not_configured";
  }
  if (!isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED)) {
    return "configured_but_paid_calls_disabled";
  }
  return "configured";
}

export type UsageTotals = {
  requests: number;
  meteredRequests: number;
  paidSubmissions: number;
  estimatedCostMicros: number;
  actualCostMicros: number;
  cacheHits: number;
  cacheMisses: number;
  blockedByBudget: number;
};

export const ZERO_USAGE: UsageTotals = {
  requests: 0,
  meteredRequests: 0,
  paidSubmissions: 0,
  estimatedCostMicros: 0,
  actualCostMicros: 0,
  cacheHits: 0,
  cacheMisses: 0,
  blockedByBudget: 0,
};

/**
 * Build the cost-centre ledger. During Phase 0 every usage figure is zero
 * because no billable path can execute, but the shape is the real one so
 * Morgana's reader and the Phase-1 implementation do not have to change.
 *
 * `dayOfMonth`/`daysInMonth` drive the projection; with zero spend the
 * projection is zero, which is the correct answer rather than a special case.
 */
export function buildCostLedger(
  config: Phase0Config,
  usage: UsageTotals = ZERO_USAGE,
  now: Date = new Date(),
): CostLedger {
  const monthlyCapMicros = config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD;
  const remainingMicros = Math.max(
    0,
    monthlyCapMicros - usage.actualCostMicros,
  );
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const projectedMicros =
    usage.actualCostMicros === 0
      ? 0
      : Math.round((usage.actualCostMicros / dayOfMonth) * daysInMonth);

  return {
    cost_centre: SEARCH_INTELLIGENCE_COST_CENTRE,
    requests: usage.requests,
    metered_requests: usage.meteredRequests,
    // Free calls are tracked separately so they can never ration paid work —
    // the failure mode Morgana diagnosed in its own pipeline (decision #84).
    free_requests: Math.max(0, usage.requests - usage.meteredRequests),
    paid_submissions: usage.paidSubmissions,
    estimated_cost_usd: toUsd(usage.estimatedCostMicros),
    actual_cost_usd: toUsd(usage.actualCostMicros),
    daily_cost_cap_usd: toUsd(config.SEO_DATAFORSEO_DAILY_COST_CAP_USD),
    monthly_cost_cap_usd: toUsd(monthlyCapMicros),
    budget_remaining_usd: toUsd(remainingMicros),
    projected_month_end_cost_usd: toUsd(projectedMicros),
    cache_hits: usage.cacheHits,
    cache_misses: usage.cacheMisses,
    blocked_by_budget: usage.blockedByBudget,
    unexpected_spend_detected: detectMeteredWhileDisabled(
      config,
      usage.meteredRequests,
    ),
  };
}
