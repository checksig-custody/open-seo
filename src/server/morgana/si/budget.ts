/**
 * Morgana Search Intelligence — budget guard and usage accounting.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Pure decision logic; persistence lives in `ledger.ts`. Money is integer
 * micro-USD everywhere (Morgana decision #3).
 *
 * This is a SECOND, independent budget from Brand Monitoring's. The two share
 * no credential, no ledger, no breaker and no code path, so exhausting or
 * revoking this one cannot slow brand collection down by a single request.
 */

export const MICROS_PER_USD = 1_000_000;

/**
 * How a call is counted. The distinction exists because Brand Monitoring was
 * throttled for weeks by conflating them (decision #84): DataForSEO's free
 * `task_get` polls consumed the request allowance and rationed the paid work,
 * spending 100% of the request budget on 22% of the money.
 */
export type MeteringClass =
  /** A billable call. Counts against requests AND metered_requests. */
  | "paid_submission"
  /** Free lifecycle poll. Counts as a request, never as metered. */
  | "free_poll"
  /** Free retrieval of an already-billed result. Request only. */
  | "result_fetch"
  /** Free of charge but rationed by an independent quota. Counts as metered. */
  | "quota_metered_free"
  /** Served from cache. No provider call happened at all. */
  | "cache";

/** Whether a class consumes the metered allowance. */
export function isMetered(meteringClass: MeteringClass): boolean {
  return (
    meteringClass === "paid_submission" ||
    meteringClass === "quota_metered_free"
  );
}

/** Whether a class represents an actual outbound provider call. */
export function isProviderCall(meteringClass: MeteringClass): boolean {
  return meteringClass !== "cache";
}

export interface BudgetLimits {
  dailyCapMicros: number;
  monthlyCapMicros: number;
  paidCallsEnabled: boolean;
  circuitBreakerThreshold: number;
}

export interface BudgetUsage {
  dailyCostMicros: number;
  monthlyCostMicros: number;
  consecutiveFailures: number;
  circuitOpenedAt: string | null;
}

export type BudgetLevel =
  | "ok"
  | "warning"
  | "degraded"
  | "stopping"
  | "exhausted";

export interface BudgetDecision {
  allowed: boolean;
  level: BudgetLevel;
  /** Machine-readable block reason; absent when allowed. */
  reason?: string;
  /** Percent of the monthly cap consumed, 0..100+. */
  monthlyPercent: number;
}

/** §25 thresholds. */
export const WARNING_PERCENT = 70;
export const DEGRADED_PERCENT = 85;
export const STOP_PERCENT = 95;

export function levelFor(percent: number): BudgetLevel {
  if (percent >= 100) return "exhausted";
  if (percent >= STOP_PERCENT) return "stopping";
  if (percent >= DEGRADED_PERCENT) return "degraded";
  if (percent >= WARNING_PERCENT) return "warning";
  return "ok";
}

const CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Decide whether a BILLABLE call may proceed.
 *
 * Reads only — the caller records usage after the fact. Cache reads and history
 * queries never come through here: at and beyond the stop threshold the product
 * must stay usable, it simply stops buying new data.
 */
export function checkBudget(
  limits: BudgetLimits,
  usage: BudgetUsage,
  now: Date = new Date(),
): BudgetDecision {
  const monthlyPercent =
    limits.monthlyCapMicros > 0
      ? (usage.monthlyCostMicros / limits.monthlyCapMicros) * 100
      : 100;

  const deny = (reason: string, level?: BudgetLevel): BudgetDecision => ({
    allowed: false,
    level: level ?? levelFor(monthlyPercent),
    reason,
    monthlyPercent,
  });

  if (!limits.paidCallsEnabled) {
    return deny("paid_calls_disabled");
  }
  // A zero cap means "cannot spend", never "unlimited". Evaluated independently
  // of the flag so enabling the flag alone can never authorise spending.
  if (limits.monthlyCapMicros <= 0 || limits.dailyCapMicros <= 0) {
    return deny("zero_cost_cap");
  }
  if (usage.circuitOpenedAt) {
    const openedAt = new Date(usage.circuitOpenedAt).getTime();
    if (
      !Number.isNaN(openedAt) &&
      now.getTime() - openedAt < CIRCUIT_COOLDOWN_MS
    ) {
      return deny("circuit_open");
    }
  }
  if (usage.monthlyCostMicros >= limits.monthlyCapMicros) {
    return deny("monthly_cap_reached", "exhausted");
  }
  if (usage.dailyCostMicros >= limits.dailyCapMicros) {
    return deny("daily_cap_reached");
  }
  if (monthlyPercent >= STOP_PERCENT) {
    // Jobs already billed may finish; no NEW billable submission starts.
    return deny("monthly_cap_stop_threshold", "stopping");
  }

  return { allowed: true, level: levelFor(monthlyPercent), monthlyPercent };
}

/**
 * The Critical condition from §30: spending happened while paid calls were off.
 * Its value is that it is checkable from outside — a smoke test can assert it.
 */
export function detectUnexpectedSpend(
  paidCallsEnabled: boolean,
  meteredRequests: number,
  actualCostMicros: number,
): boolean {
  return !paidCallsEnabled && (meteredRequests > 0 || actualCostMicros > 0);
}

/** Straight-line projection of month-end spend from the elapsed portion. */
export function projectMonthEndMicros(
  monthlyCostMicros: number,
  now: Date = new Date(),
): number {
  if (monthlyCostMicros <= 0) return 0;
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return Math.round((monthlyCostMicros / dayOfMonth) * daysInMonth);
}

/** USD float → integer micro-USD. Provider costs arrive as floats. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  return Math.round(micros) / MICROS_PER_USD;
}

/**
 * Alert thresholds crossed, given the previously announced high-water mark.
 * Returns at most one threshold so a single tick cannot emit a burst.
 */
export function crossedThreshold(
  monthlyPercent: number,
  lastAnnounced: number | null,
): number | null {
  const ladder = [WARNING_PERCENT, DEGRADED_PERCENT, STOP_PERCENT, 100];
  const reached = ladder.filter((t) => monthlyPercent >= t);
  if (reached.length === 0) return null;
  const highest = Math.max(...reached);
  if (lastAnnounced !== null && highest <= lastAnnounced) return null;
  return highest;
}
