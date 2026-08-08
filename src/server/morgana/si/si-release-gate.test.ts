import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — what the release gate refuses, and why.
 *
 * Three guarantees live here because they are the same guarantee wearing
 * different hats: THE GATE MUST NOT OVERSTATE WHAT IT KNOWS.
 *
 *   a suspended provider account stops every paid operation, and no waiver
 *   reopens it;
 *
 *   a webhook nobody examined is reported as unexamined, not as working;
 *
 *   a provider nobody has ever called is reported as unknown, not as broken —
 *   the symmetric error, and the one that would refuse the first call this
 *   subsystem ever makes.
 *
 * Kept apart from `si-budget-authority.test.ts` and `si-rollout-readiness.test.ts`
 * rather than appended to them: both were already near the 400-line ceiling, and
 * "what the gate refuses" is a subject in its own right.
 */

/**
 * A deliberately small fake db — enough for the ONE question this file asks of
 * the authority: does it consult the circuit breaker before it reserves?
 *
 * Ledger sums are constant zeros, because a cap that is nowhere near being hit
 * is exactly the condition under which a refusal has to come from somewhere
 * else. `si-budget-authority.test.ts` owns the cap arithmetic.
 */
const inserted: Record<string, unknown>[] = [];
let providerState: Record<string, unknown> | null = null;

function isProviderStateTable(table: unknown): boolean {
  return (
    typeof table === "object" &&
    table !== null &&
    "provider" in table &&
    "state" in table
  );
}

const db = {
  select: (projection: Record<string, unknown> = {}) => ({
    from: (table?: unknown) => {
      const keys = Object.keys(projection);
      const rows = isProviderStateTable(table)
        ? providerState
          ? [providerState]
          : []
        : keys.includes("actual")
          ? [{ actual: 0, requests: 0 }]
          : keys.includes("held")
            ? [{ held: 0 }]
            : keys.includes("n")
              ? [{ n: 0 }]
              : [];
      const awaitable = Object.assign(Promise.resolve(rows), {
        limit: () => Promise.resolve(rows),
        groupBy: () => Promise.resolve([]),
      });
      return { where: () => awaitable, limit: () => Promise.resolve(rows) };
    },
  }),
  insert: () => ({
    values: (value: Record<string, unknown>) => {
      inserted.push(value);
      return Promise.resolve(undefined);
    },
  }),
  update: () => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }),
};

vi.mock("@/db", () => ({ db }));
vi.mock("@/db/search-intelligence.schema", () => ({
  searchUsageLedger: { actualCostMicros: {}, meteredRequests: {}, day: {} },
}));
vi.mock("@/db/search-intelligence-p2.schema", () => ({
  phase2UsageLedger: { actualCostMicros: {}, meteredRequests: {}, day: {} },
}));
vi.mock("@/db/search-intelligence-p3.schema", () => ({
  siBacklinkUsageLedger: { actualCostMicros: {}, meteredRequests: {}, day: {} },
}));
vi.mock("@/db/search-intelligence-p5.schema", () => ({
  siSiteAuditUsageLedger: {
    actualCostMicros: {},
    meteredRequests: {},
    day: {},
  },
}));
vi.mock("@/db/search-intelligence-budget.schema", () => ({
  siBudgetReservations: {
    estimatedMaxCostMicros: {},
    budgetDay: {},
    budgetMonth: {},
    status: {},
    failureReason: {},
    id: {},
    expiresAt: {},
  },
  // The two keys `isProviderStateTable` discriminates on. A fake db that answers
  // a select-all against the wrong table is worse than no fake at all.
  siProviderState: { provider: {}, state: {} },
}));

const { authorizePaidOperation } = await import("./budget-authority");
const { readPhase0Config } = await import("../phase0-env");
const { capabilityMatrix, evaluateReleaseGate } =
  await import("./rollout-readiness");
type ReadinessFacts = Parameters<typeof evaluateReleaseGate>[1];

const config = readPhase0Config({
  SEARCH_INTELLIGENCE_ENABLED: "true",
  SEARCH_INTELLIGENCE_ENVIRONMENT: "production",
  SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
  SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
  SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2.00",
});

const authorize = () =>
  authorizePaidOperation(config, {
    collector: "ranking",
    operationType: "serp_task_post",
    worstCaseMicros: 600,
    idempotencyKey: "gate-test",
    providerConfigured: true,
  });

beforeEach(() => {
  inserted.length = 0;
  providerState = null;
});

describe("the provider-account circuit breaker, at the authority", () => {
  it("refuses every paid operation while the account is suspended", async () => {
    providerState = {
      provider: "dataforseo",
      state: "account_suspended",
      detectedAt: "2026-08-08T00:00:00.000Z",
      requiresAttention: true,
    };

    const outcome = await authorize();

    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.code).toBe("denied_provider_account_blocked");
    // AND IT TOOK NO CAPACITY. The check runs before the reservation insert, so
    // a suspended account cannot leave holds behind for a human to reconcile —
    // which is exactly how the two still-open ones came to exist.
    expect(inserted).toHaveLength(0);
  });

  it("names a rejected credential as its own thing", async () => {
    providerState = {
      provider: "dataforseo",
      state: "auth_failed",
      detectedAt: "2026-08-08T00:00:00.000Z",
      requiresAttention: true,
    };
    const outcome = await authorize();
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.reason).toContain("rotate it");
  });

  it("allows spending once the account is recorded healthy", async () => {
    providerState = {
      provider: "dataforseo",
      state: "healthy",
      detectedAt: "2026-08-08T00:00:00.000Z",
      requiresAttention: false,
    };
    expect((await authorize()).allowed).toBe(true);
  });

  it("does NOT block when the provider has never been observed", async () => {
    // Null is not a verdict. Treating "we have never asked" as a suspension
    // would refuse the first call this subsystem ever makes, which is the
    // opposite of a safety property.
    expect((await authorize()).allowed).toBe(true);
  });
});

const baseFacts: ReadinessFacts = {
  domainOverviewSnapshots: 1,
  rankObservations: 30,
  keywordsRanked: 6,
  keywordsPositioned: 4,
  rankingCoverage: 1,
  positionCoverage: 4 / 6,
  keywordsWithVolume: 6,
  keywordsTracked: 9,
  siteAuditRuns: 1,
  backlinkSnapshotsLive: 1,
  backlinkCompetitorSnapshots: 1,
  aiObservationsLive: 0,
  shareOfSearchComputable: true,
  measuredCostMicros: {
    domain_overview: 40_440,
    ranking: 1_800,
    keyword_volume: 12_840,
    backlinks: 79_236,
  },
  overDailyCap: false,
  reconciliationPending: 0,
  unexpectedSpendDetected: false,
  webhooksInvalid: [],
  webhooksEvaluated: true,
  providerCircuitState: "healthy",
};

function gateFor(overrides: Partial<ReadinessFacts>) {
  const facts = { ...baseFacts, ...overrides };
  return evaluateReleaseGate(capabilityMatrix(config, facts), facts);
}

describe("blockers the engine raises about its own limits", () => {
  it("says nobody looked at the webhooks rather than staying silent", () => {
    const codes = gateFor({
      webhooksInvalid: [],
      webhooksEvaluated: false,
    }).blockers.map((b) => b.blocker);
    expect(codes).toContain("webhooks_not_evaluated");
    // And NOT the stronger claim, which would send someone to re-enter three
    // secrets that may be perfectly fine.
    expect(codes).not.toContain("webhooks_invalid");
  });

  it("raises nothing about webhooks once they were evaluated and are fine", () => {
    const codes = gateFor({}).blockers.map((b) => b.blocker);
    expect(codes).not.toContain("webhooks_not_evaluated");
    expect(codes).not.toContain("webhooks_invalid");
  });

  it("blocks on a suspended provider account, and refuses to waive it", () => {
    const facts: ReadinessFacts = {
      ...baseFacts,
      providerCircuitState: "account_suspended",
    };
    const gate = evaluateReleaseGate(capabilityMatrix(config, facts), facts, [
      {
        capability: "provider_account",
        reason: "we would like to ship",
        approvedBy: "someone",
        approvedAt: "2026-08-08T00:00:00.000Z",
        expiresAt: null,
        impact: "none claimed",
      },
    ]);
    const row = gate.blockers.find(
      (b) => b.blocker === "provider_account_blocked",
    );
    expect(row).toBeDefined();
    // The waiver names it and changes nothing: it is outside the waivable set,
    // so no business decision can make a dead account releasable.
    expect(row?.waived).toBe(false);
    expect(gate.result).toBe("NOT_READY");
  });

  it("raises nothing when the account has never been observed", () => {
    expect(
      gateFor({ providerCircuitState: null }).blockers.map((b) => b.blocker),
    ).not.toContain("provider_account_blocked");
  });
});
