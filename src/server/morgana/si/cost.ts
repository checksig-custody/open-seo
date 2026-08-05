import { isEnabled, type Phase0Config } from "../phase0-env";
import {
  crossedThreshold,
  detectUnexpectedSpend,
  levelFor,
  microsToUsd,
  projectMonthEndMicros,
  type BudgetLevel,
} from "./budget";
import * as store from "./store";
import * as ledger from "./ledger-store";

function monthOf(date: string): string {
  return date.slice(0, 7);
}
import { resolveProviderStatus, type ProviderStatus } from "./service";

/**
 * Morgana Search Intelligence — cost centre reporting.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Split out of service.ts to stay inside the 400-line module limit. This is the
 * READ side of the ledger: what has been spent, what remains, and whether
 * anything was spent that should not have been.
 */

interface CostStatus {
  costCentre: string;
  providerStatus: ProviderStatus;
  paidCallsEnabled: boolean;
  level: BudgetLevel;
  monthlyPercent: number;
  requests: number;
  meteredRequests: number;
  freeRequests: number;
  paidSubmissions: number;
  freePollRequests: number;
  resultFetchRequests: number;
  failedRequests: number;
  retryRequests: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  dailyCostUsd: number;
  dailyCostCapUsd: number;
  monthlyCostCapUsd: number;
  budgetRemainingUsd: number;
  projectedMonthEndCostUsd: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number | null;
  blockedByBudget: number;
  unexpectedSpendDetected: boolean;
  pendingAlertThreshold: number | null;
}

export async function costStatus(
  config: Phase0Config,
  env: object,
  now: Date = new Date(),
): Promise<CostStatus> {
  const day = store.snapshotDateFor(now);
  const month = monthOf(day);
  const [totals, dayTotals, state] = await Promise.all([
    ledger.ledgerTotals(month),
    ledger.ledgerTotals(day),
    ledger.readBudgetState(month),
  ]);
  const monthlyCap = config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD;
  const monthlyPercent =
    monthlyCap > 0 ? (totals.actualCostMicros / monthlyCap) * 100 : 0;
  const paidCallsEnabled = isEnabled(
    config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED,
  );
  const cacheTotal = totals.cacheHits + totals.cacheMisses;

  return {
    costCentre: "dataforseo_search_intelligence",
    providerStatus: resolveProviderStatus(config, env),
    paidCallsEnabled,
    level: levelFor(monthlyPercent),
    monthlyPercent,
    requests: totals.requests,
    meteredRequests: totals.meteredRequests,
    // Free calls are reported separately and never ration paid work.
    freeRequests: Math.max(0, totals.requests - totals.meteredRequests),
    paidSubmissions: totals.paidSubmissions,
    freePollRequests: totals.freePollRequests,
    resultFetchRequests: totals.resultFetchRequests,
    failedRequests: totals.failedRequests,
    retryRequests: totals.retryRequests,
    estimatedCostUsd: microsToUsd(totals.estimatedCostMicros),
    actualCostUsd: microsToUsd(totals.actualCostMicros),
    dailyCostUsd: microsToUsd(dayTotals.actualCostMicros),
    dailyCostCapUsd: microsToUsd(config.SEO_DATAFORSEO_DAILY_COST_CAP_USD),
    monthlyCostCapUsd: microsToUsd(monthlyCap),
    budgetRemainingUsd: microsToUsd(
      Math.max(0, monthlyCap - totals.actualCostMicros),
    ),
    projectedMonthEndCostUsd: microsToUsd(
      projectMonthEndMicros(totals.actualCostMicros, now),
    ),
    cacheHits: totals.cacheHits,
    cacheMisses: totals.cacheMisses,
    cacheHitRate: cacheTotal > 0 ? totals.cacheHits / cacheTotal : null,
    blockedByBudget: totals.blockedByBudget,
    unexpectedSpendDetected: detectUnexpectedSpend(
      paidCallsEnabled,
      totals.meteredRequests,
      totals.actualCostMicros,
    ),
    pendingAlertThreshold: crossedThreshold(
      monthlyPercent,
      state.lastAlertThreshold,
    ),
  };
}
