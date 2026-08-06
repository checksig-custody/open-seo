/**
 * Morgana Search Intelligence — what the scheduler WOULD do, and what it would
 * cost, without doing any of it.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P16).
 *
 * Creates no job, makes no provider call, takes no reservation and writes
 * nothing. That is the whole point: the only honest way to decide a cadence is
 * to price it first, and every price here is one this subsystem has actually
 * paid — not a list price and not a model.
 *
 * AN UNKNOWN COST IS A HARD STOP, NOT A ZERO. AI Visibility has never been
 * called, so its price is unknown; an operation with an unknown price cannot be
 * scheduled automatically, because "unknown" would silently behave as "free"
 * in any sum. That rule is what stops the 2026-08-06 overrun from having a
 * sequel with a different collector.
 */

/** Costs this subsystem has MEASURED, in integer micro-USD. */
export const MEASURED_COSTS = {
  /** One Google Organic task_post. Observed 2026-08-06. */
  serp_keyword: 600,
  /** One flat-priced Keyword Overview covering the whole batch. Observed. */
  keyword_volume_batch: 12_840,
  /** Summary + 100 referring domains + 100 backlink rows. Observed. */
  backlink_sample_100: 79_236,
  /** What the guard reserves for a backlink collection. */
  backlink_reservation: 100_000,
  /** Never called. Not zero — unknown. */
  ai_visibility: null,
  /** First-party crawling: no provider is involved at all. */
  site_audit: 0,
} as const;

interface ScheduledOperation {
  collector: string;
  operation: string;
  /** How many times a day this policy would run it. */
  perDay: number;
  /** Worst-case micro-USD per run, or null when nobody has measured it. */
  worstCaseMicros: number | null;
  enabled: boolean;
}

interface DryRunPolicyInput {
  criticalKeywords: number;
  highKeywords: number;
  entities: number;
  /** The policy under consideration. Disabled entries are reported, not run. */
  policy: ScheduledOperation[];
}

interface DryRunResult {
  wouldRun: {
    collector: string;
    operation: string;
    runsPerDay: number;
    worstCaseDailyMicros: number | null;
  }[];
  excluded: { collector: string; operation: string; reason: string }[];
  projectedDailyWorstCaseMicros: number;
  projectedMonthlyWorstCaseMicros: number;
  /** Operations whose cost nobody has measured. */
  unknownCostOperations: string[];
  status:
    | "within_budget"
    | "near_cap"
    | "exceeds_cap"
    | "unknown_cost"
    | "insufficient_history";
  /** Why the status is what it is, in this engine's own words. */
  reason: string;
}

/**
 * The proposed cadence, as configuration rather than as behaviour.
 *
 * Every entry ships `enabled: false`. Turning one on is a decision that must be
 * made against the numbers this function produces, not against an intuition
 * about how often a ranking "should" be checked.
 */
export function proposedPolicy(input: {
  criticalKeywords: number;
  highKeywords: number;
  entities: number;
}): ScheduledOperation[] {
  return [
    {
      collector: "ranking",
      operation: "serp_task_post_critical",
      // Every 6 hours: 4 runs a day, one paid SERP per keyword.
      perDay: 4 * input.criticalKeywords,
      worstCaseMicros: MEASURED_COSTS.serp_keyword,
      enabled: false,
    },
    {
      collector: "ranking",
      operation: "serp_task_post_high",
      perDay: 1 * input.highKeywords,
      worstCaseMicros: MEASURED_COSTS.serp_keyword,
      enabled: false,
    },
    {
      collector: "ranking",
      operation: "serp_task_get_recovery",
      // Free: the SERP was charged at submission. Included so the plan shows
      // the work, not only the money.
      perDay: 72,
      worstCaseMicros: 0,
      enabled: false,
    },
    {
      collector: "keyword_volume",
      operation: "keyword_overview_batch",
      // Monthly, expressed per day so one sum covers every cadence.
      perDay: 1 / 30,
      worstCaseMicros: MEASURED_COSTS.keyword_volume_batch,
      enabled: false,
    },
    {
      collector: "domain_overview",
      operation: "labs_domain_overview",
      perDay: input.entities,
      // Measured by phase 1: three Labs calls per refresh, ~40 440 µUSD.
      worstCaseMicros: 40_440,
      enabled: false,
    },
    {
      collector: "site_audit",
      operation: "first_party_crawl",
      perDay: 1 / 7,
      worstCaseMicros: MEASURED_COSTS.site_audit,
      enabled: false,
    },
    {
      collector: "backlinks",
      operation: "backlink_collection",
      perDay: 0,
      worstCaseMicros: MEASURED_COSTS.backlink_reservation,
      enabled: false,
    },
    {
      collector: "ai_visibility",
      operation: "llm_response",
      perDay: 0,
      worstCaseMicros: MEASURED_COSTS.ai_visibility,
      enabled: false,
    },
  ];
}

/**
 * Price a policy against the real caps.
 *
 * Only ENABLED operations contribute; the rest are reported as excluded with a
 * reason, because a plan that hides what it is not doing is not a plan.
 */
export function dryRunSchedule(
  input: DryRunPolicyInput,
  caps: { dailyMicros: number; monthlyMicros: number },
): DryRunResult {
  const wouldRun: DryRunResult["wouldRun"] = [];
  const excluded: DryRunResult["excluded"] = [];
  const unknownCostOperations: string[] = [];
  let dailyWorstCase = 0;

  for (const operation of input.policy) {
    if (!operation.enabled) {
      excluded.push({
        collector: operation.collector,
        operation: operation.operation,
        reason: "disabled_by_policy",
      });
      continue;
    }
    if (operation.worstCaseMicros === null) {
      // Unknown is not zero. An operation nobody has priced cannot be part of a
      // budget, so it is excluded and named.
      unknownCostOperations.push(
        `${operation.collector}/${operation.operation}`,
      );
      excluded.push({
        collector: operation.collector,
        operation: operation.operation,
        reason: "cost_unknown",
      });
      continue;
    }
    const daily = Math.round(operation.perDay * operation.worstCaseMicros);
    dailyWorstCase += daily;
    wouldRun.push({
      collector: operation.collector,
      operation: operation.operation,
      runsPerDay: operation.perDay,
      worstCaseDailyMicros: daily,
    });
  }

  const monthly = dailyWorstCase * 30;
  const status: DryRunResult["status"] =
    unknownCostOperations.length > 0
      ? "unknown_cost"
      : dailyWorstCase > caps.dailyMicros || monthly > caps.monthlyMicros
        ? "exceeds_cap"
        : dailyWorstCase > caps.dailyMicros * 0.8
          ? "near_cap"
          : "within_budget";

  const reason =
    unknownCostOperations.length > 0
      ? `cost unknown for: ${unknownCostOperations.join(", ")}`
      : status === "exceeds_cap"
        ? "the worst case of this cadence does not fit inside the caps"
        : status === "near_cap"
          ? "the worst case uses more than 80% of the daily cap"
          : "the worst case fits inside both caps";

  return {
    wouldRun,
    excluded,
    projectedDailyWorstCaseMicros: dailyWorstCase,
    projectedMonthlyWorstCaseMicros: monthly,
    unknownCostOperations,
    status,
    reason,
  };
}
