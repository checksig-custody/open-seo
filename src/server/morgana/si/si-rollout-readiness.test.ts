import { describe, expect, it } from "vitest";
import {
  capabilityMatrix,
  evaluateReleaseGate,
  MIN_RANKING_COVERAGE,
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

/**
 * Production as it actually stands, read back from D1 on 2026-08-07.
 *
 * The numbers matter to each other. `si_rank_snapshots` holds FIVE live rows —
 * one keyword observed against CheckSig and four competitors — for ONE distinct
 * keyword, out of six with a measured volume. Coverage is therefore 1/6, not
 * 5/6, and the difference is the defect this fixture exists to keep out: the
 * two populations were divided into each other and the gate reported Share of
 * Search as computable while the metric itself refused.
 */
const productionFacts: ReadinessFacts = {
  domainOverviewSnapshots: 1,
  rankObservations: 5,
  keywordsRanked: 1,
  keywordsPositioned: 1,
  rankingCoverage: 1 / 6,
  positionCoverage: 1 / 6,
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

  it("notices when the competitor collection has actually happened", () => {
    // This row used to key only off the budget day, so with Conio collected,
    // persisted and differenced it still reported `no_live_provider_run` — a
    // capability unable to see its own data.
    const collected = new Map(
      capabilityMatrix(config, {
        ...productionFacts,
        backlinkCompetitorSnapshots: 1,
        overDailyCap: false,
      }).map((c) => [c.id, c]),
    );
    const gap = collected.get("backlink_competitor_gap");
    expect(gap?.liveVerification).toBe("live_verified");
    expect(gap?.state).toBe("ready_for_activation");
    expect(gap?.blockers).toEqual([]);
    // And it stays PARTIAL: two 100-row samples of two much larger indexes are
    // comparable, not complete.
    expect(gap?.dataAvailability).toBe("partial");
  });

  it("reports a verified capability with data as ready for a human decision", () => {
    expect(byId.get("keyword_volume")?.state).toBe("ready_for_activation");
    expect(byId.get("domain_overview")?.state).toBe("ready_for_activation");
  });

  it("leaves Site Audit's provider cost null rather than zero", () => {
    // First-party crawling: nobody was charged. A 0 would read as a measurement.
    expect(byId.get("site_audit")?.lastProviderCostMicros).toBeNull();
  });

  it("reports Site Audit unverified until a crawl has actually completed", () => {
    // `siteAuditRuns` used to be a count of ALL rows — the only fact in the
    // readiness model without a provenance filter — so a `queued` run that
    // never advanced, or a `failed` one, satisfied the gate. The fact now
    // counts completed first-party crawls that read at least one page, and the
    // matrix follows it.
    const noRuns = new Map(
      capabilityMatrix(config, {
        ...productionFacts,
        siteAuditRuns: 0,
      }).map((c) => [c.id, c]),
    );
    expect(noRuns.get("site_audit")?.blockers).toEqual([
      "no_live_provider_run",
    ]);
    expect(noRuns.get("site_audit")?.state).toBe("live_verification_pending");
  });
});

/**
 * The blocker that could never close.
 *
 * `ranking` used to emit `insufficient_ranking_coverage` whenever a single
 * observation existed, comparing against nothing. It is also not waivable. The
 * two together made the gate permanently shut: the first live rank closed it
 * and no amount of collection could reopen it. These tests pin the fix without
 * moving the threshold, which stays at 0.5.
 */
describe("ranking coverage", () => {
  const covered: ReadinessFacts = {
    ...productionFacts,
    rankObservations: 30,
    keywordsRanked: 6,
    keywordsPositioned: 4,
    rankingCoverage: 1,
    positionCoverage: 4 / 6,
    shareOfSearchComputable: true,
  };

  it("clears the blocker once the eligible watchlist has been measured", () => {
    const byId = new Map(
      capabilityMatrix(config, covered).map((c) => [c.id, c]),
    );
    expect(byId.get("ranking")?.blockers).toEqual([]);
    expect(byId.get("ranking")?.dataAvailability).toBe("sufficient");
  });

  it("keeps the blocker while coverage is below the threshold", () => {
    const byId = new Map(
      capabilityMatrix(config, productionFacts).map((c) => [c.id, c]),
    );
    expect(byId.get("ranking")?.blockers).toEqual([
      "insufficient_ranking_coverage",
    ]);
    expect(byId.get("ranking")?.dataAvailability).toBe("partial");
  });

  it("holds the threshold at exactly half, in both directions", () => {
    expect(MIN_RANKING_COVERAGE).toBe(0.5);
    const at = (rankingCoverage: number) =>
      capabilityMatrix(config, {
        ...productionFacts,
        rankObservations: 10,
        rankingCoverage,
      }).find((c) => c.id === "ranking")?.blockers ?? [];
    // Exactly at the threshold passes; a hair under does not. Pinned so the
    // boundary cannot be nudged without a test saying so.
    expect(at(0.5)).toEqual([]);
    expect(at(0.4999)).toEqual(["insufficient_ranking_coverage"]);
  });

  it("still reports no live run when nothing has been collected at all", () => {
    const byId = new Map(
      capabilityMatrix(config, {
        ...productionFacts,
        rankObservations: 0,
        keywordsRanked: 0,
        keywordsPositioned: 0,
        rankingCoverage: 0,
        positionCoverage: 0,
      }).map((c) => [c.id, c]),
    );
    // An absent collector is not a coverage problem, and saying so would send
    // someone to buy data for a path that has never run.
    expect(byId.get("ranking")?.blockers).toEqual(["no_live_provider_run"]);
    expect(byId.get("ranking")?.dataAvailability).toBe("none");
  });

  it("lets the gate open again once coverage is real", () => {
    // The point of the whole fix: with the eligible watchlist measured, the
    // ranking blocker disappears from the gate entirely.
    const gate = evaluateReleaseGate(
      capabilityMatrix(config, covered),
      covered,
    );
    expect(
      gate.blockers.some((b) => b.blocker === "insufficient_ranking_coverage"),
    ).toBe(false);
  });
});

describe("Share of Search names the shortage it actually has", () => {
  it("says coverage when the watchlist has not been measured", () => {
    const byId = new Map(
      capabilityMatrix(config, productionFacts).map((c) => [c.id, c]),
    );
    expect(byId.get("share_of_search")?.blockers).toEqual([
      "insufficient_ranking_coverage",
    ]);
  });

  it("says positions when it has been measured and CheckSig does not rank", () => {
    // Every eligible keyword collected; only one came back with a position.
    // More spend cannot fix this, so reporting it as a collection gap would
    // send someone to buy data that already exists.
    const measuredButUnranked: ReadinessFacts = {
      ...productionFacts,
      rankObservations: 30,
      keywordsRanked: 6,
      keywordsPositioned: 1,
      rankingCoverage: 1,
      positionCoverage: 1 / 6,
      shareOfSearchComputable: false,
    };
    const byId = new Map(
      capabilityMatrix(config, measuredButUnranked).map((c) => [c.id, c]),
    );
    expect(byId.get("share_of_search")?.blockers).toEqual([
      "insufficient_ranked_positions",
    ]);
    expect(byId.get("share_of_search")?.state).toBe("insufficient_data");
    // And the ranking row is satisfied, because the question it asks — have we
    // looked — has been answered.
    expect(byId.get("ranking")?.blockers).toEqual([]);
  });

  it("clears both once enough keywords hold a position", () => {
    const byId = new Map(
      capabilityMatrix(config, {
        ...productionFacts,
        rankObservations: 30,
        keywordsRanked: 6,
        keywordsPositioned: 3,
        rankingCoverage: 1,
        positionCoverage: 0.5,
        shareOfSearchComputable: true,
      }).map((c) => [c.id, c]),
    );
    expect(byId.get("share_of_search")?.blockers).toEqual([]);
    expect(byId.get("share_of_search")?.state).toBe("ready_for_activation");
  });

  it("never waives a ranking shortage of either kind", () => {
    // Both codes are outside WAIVABLE. A waiver naming them changes nothing,
    // which is the property that makes them worth reporting separately.
    const measuredButUnranked: ReadinessFacts = {
      ...productionFacts,
      keywordsRanked: 6,
      keywordsPositioned: 1,
      rankingCoverage: 1,
      positionCoverage: 1 / 6,
    };
    const gate = evaluateReleaseGate(
      capabilityMatrix(config, measuredButUnranked),
      measuredButUnranked,
      [
        {
          capability: "share_of_search",
          reason: "we would rather not wait",
          approvedBy: "someone",
          approvedAt: "2026-08-07T12:00:00.000Z",
          expiresAt: null,
          impact: "none claimed",
        },
      ],
    );
    expect(
      gate.blockers.find((b) => b.capability === "share_of_search")?.waived,
    ).toBe(false);
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
