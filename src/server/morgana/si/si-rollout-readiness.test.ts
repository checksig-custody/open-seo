import { describe, expect, it } from "vitest";
import {
  capabilityMatrix,
  evaluateReleaseGate,
  type ReadinessFacts,
} from "./rollout-readiness";
import {
  dryRunSchedule,
  proposedPolicy,
  MEASURED_COSTS,
} from "./scheduler-dry-run";
import { readPhase0Config } from "../phase0-env";

/**
 * Morgana Search Intelligence — readiness that cannot flatter itself.
 *
 * Two failure modes are being guarded against, and both are ways of turning
 * "we built it" into "it works":
 *
 *   reporting implementation as live verification;
 *   letting an unpriced operation behave as a free one in a budget.
 */

const config = readPhase0Config({
  SEARCH_INTELLIGENCE_ENABLED: "true",
  SEARCH_INTELLIGENCE_ENVIRONMENT: "production",
  SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
  SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2.00",
});

/** Production as it actually stands on 2026-08-06. */
const productionFacts: ReadinessFacts = {
  domainOverviewSnapshots: 1,
  rankObservations: 5,
  keywordsWithVolume: 6,
  keywordsTracked: 9,
  siteAuditRuns: 1,
  backlinkSnapshotsLive: 1,
  backlinkCompetitorSnapshots: 0,
  aiObservationsLive: 0,
  shareOfSearchComputable: false,
  measuredCostMicros: {
    domain_overview: 40_440,
    ranking: 600,
    keyword_volume: 12_840,
    backlinks: 79_236,
  },
  overDailyCap: true,
  reconciliationPending: 0,
  unexpectedSpendDetected: false,
  webhooksInvalid: ["intel", "brand_protection", "security"],
};

describe("the capability matrix", () => {
  const matrix = capabilityMatrix(config, productionFacts);
  const byId = new Map(matrix.map((c) => [c.id, c]));

  it("never reports implementation as live verification", () => {
    const ai = byId.get("ai_visibility");
    expect(ai?.implementation).toBe("implemented");
    // Built, and never once served by a provider. Both true, and the second is
    // the one that decides whether anyone may rely on it.
    expect(ai?.liveVerification).toBe("live_verification_pending");
    expect(ai?.state).toBe("live_verification_pending");
  });

  it("names both unknowns for AI visibility, not just 'not ready'", () => {
    expect(byId.get("ai_visibility")?.blockers).toEqual([
      "provider_entitlement_unverified",
      "provider_cost_unknown",
    ]);
  });

  it("separates a working metric from a computable one", () => {
    const share = byId.get("share_of_search");
    // The code works and its inputs are live; the metric still refuses because
    // coverage is 1 of 6. Reporting that as "not implemented" would send
    // someone to rewrite working code.
    expect(share?.liveVerification).toBe("live_verified");
    expect(share?.state).toBe("insufficient_data");
    expect(share?.blockers).toEqual(["insufficient_ranking_coverage"]);
  });

  it("calls a verified collector with a thin dataset partial, not sufficient", () => {
    const ranking = byId.get("ranking");
    expect(ranking?.liveVerification).toBe("live_verified");
    expect(ranking?.dataAvailability).toBe("partial");
    expect(ranking?.blockers).toContain("insufficient_ranking_coverage");
  });

  it("blocks the competitor gap on the budget day, not on missing code", () => {
    const gap = byId.get("backlink_competitor_gap");
    expect(gap?.implementation).toBe("implemented");
    expect(gap?.state).toBe("blocked_by_budget");
    expect(gap?.blockers).toEqual(["blocked_by_budget_day"]);
  });

  it("reports a verified capability with data as ready for a human decision", () => {
    expect(byId.get("keyword_volume")?.state).toBe("ready_for_activation");
    expect(byId.get("domain_overview")?.state).toBe("ready_for_activation");
  });

  it("leaves Site Audit's provider cost null rather than zero", () => {
    // First-party crawling: nobody was charged. A 0 would read as a measurement.
    expect(byId.get("site_audit")?.lastProviderCostMicros).toBeNull();
  });
});

describe("the release gate", () => {
  const matrix = capabilityMatrix(config, productionFacts);

  it("is NOT_READY today, and says which blocker to look at first", () => {
    const gate = evaluateReleaseGate(matrix, productionFacts);
    expect(gate.result).toBe("NOT_READY");
    expect(gate.summary).toContain("unwaived blocker");
  });

  it("reaches READY_WITH_WAIVERS only for the two things that may be waived", () => {
    const waivers = [
      {
        capability: "ai_visibility",
        reason: "entitlement unproven; no paid call authorised",
        approvedBy: "mattia@checksig.com",
        approvedAt: "2026-08-06T20:00:00.000Z",
        expiresAt: null,
        impact: "AI surfaces report unsupported until verified",
      },
      {
        capability: "backlink_competitor_gap",
        reason: "deferred to a budget day with room",
        approvedBy: "mattia@checksig.com",
        approvedAt: "2026-08-06T20:00:00.000Z",
        expiresAt: null,
        impact: "gap shows one side only",
      },
      {
        capability: "webhooks_invalid",
        reason: "alerts are off; delivery suppressed with a reason",
        approvedBy: "mattia@checksig.com",
        approvedAt: "2026-08-06T20:00:00.000Z",
        expiresAt: null,
        impact: "no Search Intelligence alert can be delivered",
      },
    ];
    // Ranking coverage is still a blocker and is NOT waivable, so even with
    // every legitimate waiver the gate stays shut.
    const gate = evaluateReleaseGate(matrix, productionFacts, waivers);
    expect(gate.result).toBe("NOT_READY");
    expect(
      gate.blockers.some(
        (b) => b.blocker === "insufficient_ranking_coverage" && !b.waived,
      ),
    ).toBe(true);
  });

  it("refuses to waive anything outside the allowed set", () => {
    const gate = evaluateReleaseGate(matrix, productionFacts, [
      {
        capability: "ranking",
        reason: "we would rather not wait",
        approvedBy: "someone",
        approvedAt: "2026-08-06T20:00:00.000Z",
        expiresAt: null,
        impact: "none claimed",
      },
    ]);
    expect(gate.blockers.find((b) => b.capability === "ranking")?.waived).toBe(
      false,
    );
  });

  it("treats reconciliation pending and unexpected spend as hard blockers", () => {
    const gate = evaluateReleaseGate(matrix, {
      ...productionFacts,
      reconciliationPending: 1,
      unexpectedSpendDetected: true,
    });
    const codes = gate.blockers.map((b) => b.blocker);
    expect(codes).toContain("reconciliation_pending");
    expect(codes).toContain("unexpected_spend_detected");
  });
});

describe("the scheduler dry run", () => {
  const caps = { dailyMicros: 200_000, monthlyMicros: 2_000_000 };

  it("creates nothing: it is a calculation, not an execution", () => {
    const policy = proposedPolicy({
      criticalKeywords: 5,
      highKeywords: 4,
      entities: 5,
    });
    // Every proposed entry ships disabled, so a dry run of the proposal spends
    // nothing and schedules nothing.
    expect(policy.every((operation) => !operation.enabled)).toBe(true);
    const result = dryRunSchedule(
      { criticalKeywords: 5, highKeywords: 4, entities: 5, policy },
      caps,
    );
    expect(result.wouldRun).toHaveLength(0);
    expect(result.projectedDailyWorstCaseMicros).toBe(0);
  });

  it("prices the proposed ranking cadence against what a SERP actually cost", () => {
    const policy = proposedPolicy({
      criticalKeywords: 5,
      highKeywords: 4,
      entities: 0,
    }).map((operation) =>
      operation.operation.startsWith("serp_task_post")
        ? { ...operation, enabled: true }
        : operation,
    );
    const result = dryRunSchedule(
      { criticalKeywords: 5, highKeywords: 4, entities: 0, policy },
      caps,
    );
    // 4 checks a day × 5 critical + 1 × 4 high = 24 SERPs at 600 µUSD.
    expect(result.projectedDailyWorstCaseMicros).toBe(24 * 600);
    // 14 400 of a 200 000 cap.
    expect(result.status).toBe("within_budget");
  });

  it("refuses to schedule an operation nobody has priced", () => {
    const policy = proposedPolicy({
      criticalKeywords: 0,
      highKeywords: 0,
      entities: 0,
    }).map((operation) =>
      operation.collector === "ai_visibility"
        ? { ...operation, enabled: true, perDay: 1 }
        : operation,
    );
    const result = dryRunSchedule(
      { criticalKeywords: 0, highKeywords: 0, entities: 0, policy },
      caps,
    );
    // Unknown is not zero: it is excluded, named, and it changes the status of
    // the whole plan rather than quietly contributing nothing to the sum.
    expect(result.unknownCostOperations).toEqual([
      "ai_visibility/llm_response",
    ]);
    expect(result.status).toBe("unknown_cost");
    expect(result.projectedDailyWorstCaseMicros).toBe(0);
  });

  it("says exceeds_cap when a cadence would not fit", () => {
    const policy = proposedPolicy({
      criticalKeywords: 5,
      highKeywords: 4,
      entities: 5,
    }).map((operation) =>
      operation.collector === "backlinks"
        ? { ...operation, enabled: true, perDay: 3 }
        : operation,
    );
    const result = dryRunSchedule(
      { criticalKeywords: 5, highKeywords: 4, entities: 5, policy },
      caps,
    );
    // Three backlink collections a day at the 100 000 µUSD reservation is
    // 300 000 against a 200 000 cap.
    expect(result.status).toBe("exceeds_cap");
  });

  it("keeps the measured costs as the source of truth", () => {
    expect(MEASURED_COSTS.serp_keyword).toBe(600);
    expect(MEASURED_COSTS.keyword_volume_batch).toBe(12_840);
    expect(MEASURED_COSTS.backlink_sample_100).toBe(79_236);
    // Never called, so never priced. This must stay null.
    expect(MEASURED_COSTS.ai_visibility).toBeNull();
  });
});
