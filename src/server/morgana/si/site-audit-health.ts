import type { IssueSeverity } from "./site-audit-checks";

/**
 * Morgana Search Intelligence — the Site Health model.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * A single 0–100 number is useful for a trend line and dangerous everywhere
 * else, because it invites people to stop looking at the issues. So this model
 * is built to be argued with:
 *
 * - the **version** is stored on every run, so a score can never be compared
 *   across a silent change to the formula;
 * - the **components** travel with the score — severity, weight, count and
 *   affected pages — and the UI renders them next to it;
 * - a **partial crawl produces no score at all**, because a score computed from
 *   80 of 500 pages is not a smaller score, it is a different measurement.
 *
 * The shape is deliberately dull: a weighted penalty per issue, normalised by
 * pages crawled, subtracted from 100. Nothing here is a model of anything —
 * it is an ordering device with its arithmetic on display.
 */

export const HEALTH_MODEL_VERSION = "site-health-2026-08-v1";

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = {
  critical: 25,
  high: 10,
  medium: 3,
  low: 1,
  info: 0,
};

interface HealthComponent {
  severity: IssueSeverity;
  weight: number;
  issueCount: number;
  affectedPages: number;
  penalty: number;
}

interface HealthResult {
  /** Null when the crawl was not complete enough to score honestly. */
  score: number | null;
  modelVersion: string;
  components: HealthComponent[];
  issuesConsidered: number;
  pagesCrawled: number;
  /** Why a score is absent, when it is. */
  reason: string | null;
}

interface HealthInput {
  pagesCrawled: number;
  comparisonStatus: "complete" | "partial" | "not_comparable";
  issues: readonly { severity: IssueSeverity; pageUrl: string | null }[];
}

/**
 * Compute Site Health.
 *
 * The normalisation is per-page: a hundred missing alt attributes on a
 * five-page site is a different signal from the same hundred across five
 * hundred pages, and an absolute penalty would call them equal. `info` issues
 * carry weight zero — they are recorded, not scored.
 */
export function siteHealth(input: HealthInput): HealthResult {
  if (input.comparisonStatus !== "complete") {
    return {
      score: null,
      modelVersion: HEALTH_MODEL_VERSION,
      components: [],
      issuesConsidered: 0,
      pagesCrawled: input.pagesCrawled,
      reason:
        "the crawl was partial; a score computed from an incomplete crawl would not be comparable",
    };
  }
  if (input.pagesCrawled === 0) {
    return {
      score: null,
      modelVersion: HEALTH_MODEL_VERSION,
      components: [],
      issuesConsidered: 0,
      pagesCrawled: 0,
      reason: "no page was crawled",
    };
  }

  const severities: IssueSeverity[] = [
    "critical",
    "high",
    "medium",
    "low",
    "info",
  ];
  const components: HealthComponent[] = [];
  let totalPenalty = 0;
  let considered = 0;

  for (const severity of severities) {
    const matching = input.issues.filter(
      (entry) => entry.severity === severity,
    );
    if (matching.length === 0) continue;
    const affectedPages = new Set(
      matching.map((entry) => entry.pageUrl ?? "__site__"),
    ).size;
    const weight = SEVERITY_WEIGHT[severity];
    // Penalty scales with the SHARE of pages affected, not the raw count, so
    // one broken page on a large site cannot dominate the score.
    const penalty =
      weight === 0
        ? 0
        : (weight * Math.min(affectedPages, input.pagesCrawled)) /
          input.pagesCrawled;
    components.push({
      severity,
      weight,
      issueCount: matching.length,
      affectedPages,
      penalty: Number(penalty.toFixed(2)),
    });
    totalPenalty += penalty;
    if (weight > 0) considered += matching.length;
  }

  const score = Math.max(0, Math.min(100, 100 - totalPenalty));
  return {
    score: Number(score.toFixed(1)),
    modelVersion: HEALTH_MODEL_VERSION,
    components,
    issuesConsidered: considered,
    pagesCrawled: input.pagesCrawled,
    reason: null,
  };
}
