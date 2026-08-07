import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — the global budget authority.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P14).
 *
 * Every case here descends from one incident. On 2026-08-06 four collectors each
 * held their own ledger and their own guard; each guard compared its own spend
 * against the shared 0.20 USD cap; the backlink guard saw zero backlink spend,
 * allowed a 0.0792 USD collection, and the day summed to 0.21400 USD. Nothing
 * was bypassed — four correct local answers added up to a wrong global one.
 *
 * So the tests ask two questions of every path: does it see ALL the money, and
 * can two callers running at once both get through?
 */

const rows: Record<string, unknown[]> = {};
const inserted: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];
let insertShouldConflict = false;

/** A tiny stand-in for the query builder, shaped like the calls under test. */
const makeDb = () => ({
  // `select()` with no projection is a select-all: that is how a reservation
  // is read back before it is committed.
  select: (projection: Record<string, unknown> = {}) => ({
    from: () => {
      const result = currentRows(projection);
      // `.where(...)` is sometimes awaited directly and sometimes followed by
      // `.limit(1)`, so the object it returns has to be both.
      const thenable = {
        limit: () => Promise.resolve(result),
        then: (resolve: (v: unknown) => unknown) => resolve(result),
      };
      return { where: () => thenable, limit: () => Promise.resolve(result) };
    },
  }),
  insert: () => ({
    values: (value: Record<string, unknown>) => {
      if (insertShouldConflict) {
        return Promise.reject(new Error("UNIQUE constraint failed"));
      }
      inserted.push(value);
      // RESERVE-THEN-VERIFY made observable: the reservation this call just
      // wrote is visible to the re-read that follows, which is the whole
      // mechanism a concurrent caller relies on.
      scenario.heldMicros += Number(value.estimatedMaxCostMicros ?? 0);
      return Promise.resolve(undefined);
    },
  }),
  update: () => ({
    set: (value: Record<string, unknown>) => ({
      where: () => {
        updates.push(value);
        return {
          returning: () => Promise.resolve([{ id: "br_1" }]),
          then: (resolve: (v: unknown) => unknown) => resolve(undefined),
        };
      },
    }),
  }),
});

/**
 * The aggregate under test is a set of SUMs, so the double returns whatever the
 * current scenario says each SUM should be. Keyed by the projection's shape,
 * which is enough to tell the queries apart without a SQL engine.
 */
let scenario = {
  ledgerActual: 0,
  ledgerRequests: 0,
  heldMicros: 0,
  pendingCount: 0,
  exceededCount: 0,
  reservation: null as Record<string, unknown> | null,
};

function currentRows(projection: Record<string, unknown>): unknown[] {
  const keys = Object.keys(projection ?? {});
  if (keys.includes("actual")) {
    return [
      { actual: scenario.ledgerActual, requests: scenario.ledgerRequests },
    ];
  }
  if (keys.includes("held")) return [{ held: scenario.heldMicros }];
  if (keys.includes("n")) {
    // Two different COUNT(*) queries: pending reconciliations, then estimate
    // overruns. They are asked in that order.
    const value =
      countCalls === 0 ? scenario.pendingCount : scenario.exceededCount;
    countCalls += 1;
    return [{ n: value }];
  }
  return scenario.reservation ? [scenario.reservation] : [];
}
let countCalls = 0;

vi.mock("@/db", () => ({ db: makeDb() }));
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
}));

const {
  globalSpend,
  authorizePaidOperation,
  commitReservation,
  budgetDay,
  budgetMonth,
} = await import("./budget-authority");

const config = {
  SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
  SEO_DATAFORSEO_DAILY_COST_CAP_USD: 200_000,
  SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: 2_000_000,
} as unknown as Parameters<typeof globalSpend>[0];

const authorize = (worstCaseMicros: number, key = "op-1") =>
  authorizePaidOperation(config, {
    collector: "backlinks",
    operationType: "backlink_collection",
    worstCaseMicros,
    idempotencyKey: key,
    providerConfigured: true,
  });

beforeEach(() => {
  inserted.length = 0;
  updates.length = 0;
  countCalls = 0;
  insertShouldConflict = false;
  scenario = {
    ledgerActual: 0,
    ledgerRequests: 0,
    heldMicros: 0,
    pendingCount: 0,
    exceededCount: 0,
    reservation: null,
  };
});

describe("the aggregate", () => {
  it("sums every ledger, not one", async () => {
    // Each of the four ledgers reports the same figure in this double, so the
    // total proves all four were read rather than one.
    scenario.ledgerActual = 30_000;
    const spend = await globalSpend(config);
    // Three ledgers, not four: Site Audit crawls first-party pages and has no
    // cost column at all, so including it would mean inventing money for a
    // subsystem that spends none.
    expect(spend.dailyActualMicros).toBe(90_000);
    expect(spend.perCollector.map((c) => c.collector)).toEqual([
      "domain_overview",
      "phase2",
      "backlinks",
    ]);
  });

  it("shows the overrun instead of clamping it to zero", async () => {
    // The actual state of 2026-08-06: more spent than the cap allows.
    scenario.ledgerActual = 71_333; // ×3 ≈ 214 000 µUSD, the real overrun
    const spend = await globalSpend(config);
    expect(spend.dailyActualMicros).toBe(213_999);
    expect(spend.overDailyCap).toBe(true);
    expect(spend.availableDailyMicros).toBeLessThan(0);
  });

  it("counts open reservations as spent, and committed ones only once", async () => {
    scenario.ledgerActual = 10_000;
    scenario.heldMicros = 25_000;
    const spend = await globalSpend(config);
    // 30 000 in the ledgers + 25 000 still held. A committed reservation is not
    // added on top of the ledger it already produced.
    expect(spend.availableDailyMicros).toBe(200_000 - 30_000 - 25_000);
  });
});

describe("authorization", () => {
  it("allows an operation that fits and holds capacity for it", async () => {
    scenario.ledgerActual = 10_000;
    const outcome = await authorize(25_000);
    expect(outcome.allowed).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].estimatedMaxCostMicros).toBe(25_000);
    expect(inserted[0].status).toBe("reserved");
  });

  it("refuses when the worst case would breach the global daily cap", async () => {
    // 0.19 in the ledgers overall; one more 25 000 µUSD operation does not fit.
    scenario.ledgerActual = 63_334; // ×3 > 0.19 USD
    const outcome = await authorize(25_000);
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.code).toBe("denied_daily_cap");
    // The reservation is inserted then released, so a racing caller sees it.
    expect(updates.some((u) => u.status === "released")).toBe(true);
  });

  it("refuses a second caller that would breach the cap together with the first", async () => {
    // The concurrency case: the first caller's reservation is visible as held
    // capacity, and the second one backs off rather than both proceeding.
    scenario.ledgerActual = 53_334; // ×3 = 160 002
    scenario.heldMicros = 25_000;
    const outcome = await authorize(25_000, "op-2");
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.code).toBe("denied_daily_cap");
  });

  it("refuses a duplicate operation instead of reserving twice", async () => {
    insertShouldConflict = true;
    const outcome = await authorize(25_000, "same-key");
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed)
      expect(outcome.code).toBe("denied_duplicate_operation");
  });

  it("refuses when paid calls are off, before touching the database", async () => {
    const outcome = await authorizePaidOperation(
      {
        ...config,
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "false",
      } as typeof config,
      {
        collector: "backlinks",
        operationType: "backlink_collection",
        worstCaseMicros: 25_000,
        idempotencyKey: "off",
        providerConfigured: true,
      },
    );
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed)
      expect(outcome.code).toBe("denied_paid_calls_disabled");
    expect(inserted).toHaveLength(0);
  });

  it("refuses with no credential, whatever the budget says", async () => {
    const outcome = await authorizePaidOperation(config, {
      collector: "backlinks",
      operationType: "backlink_collection",
      worstCaseMicros: 1,
      idempotencyKey: "nocred",
      providerConfigured: false,
    });
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.code).toBe("denied_provider_not_configured");
    }
  });

  it("stops everything once a previous operation exceeded its estimate", async () => {
    // The Backlinks case: 79 236 µUSD against a 25 000 µUSD estimate. Until a
    // human looks, the cost model is known to be wrong somewhere.
    scenario.exceededCount = 1;
    const outcome = await authorize(1_000);
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.code).toBe("denied_unexpected_spend");
  });

  it("records what it authorised, not only how much", async () => {
    // A reservation that says `backlinks / 100000` and nothing else can be
    // summed but not audited: which domain, and how many rows, were only
    // recoverable by correlating timestamps against a snapshot table. The
    // sample size matters most of all — Backlinks charges per returned row, so
    // an estimate is checkable only against the sample it assumed.
    await authorizePaidOperation(config, {
      collector: "backlinks",
      operationType: "backlink_collection",
      worstCaseMicros: 100_000,
      idempotencyKey: "backlinks|se_conio|2026-08-07T17",
      subject: "conio.com",
      subjectScope: 100,
      operationId: "bop_1",
      providerConfigured: true,
    });
    expect(inserted[0]).toMatchObject({
      collector: "backlinks",
      subject: "conio.com",
      subjectScope: 100,
      operationId: "bop_1",
      estimatedMaxCostMicros: 100_000,
    });
  });

  it("states an absent subject as null rather than inventing one", async () => {
    await authorize(1_000, "no-subject");
    expect(inserted[0]?.subject).toBeNull();
    expect(inserted[0]?.subjectScope).toBeNull();
  });
});

describe("reconciliation", () => {
  beforeEach(() => {
    scenario.reservation = { id: "br_1", estimatedMaxCostMicros: 25_000 };
  });

  it("commits the real cost and frees the held capacity", async () => {
    const result = await commitReservation("br_1", {
      actualCostMicros: 12_840,
      costStatus: "reported",
    });
    expect(result.estimateExceeded).toBe(false);
    expect(updates[0].status).toBe("committed");
    expect(updates[0].actualCostMicros).toBe(12_840);
  });

  it("records the whole overrun rather than truncating it to the estimate", async () => {
    const result = await commitReservation("br_1", {
      actualCostMicros: 79_236,
      costStatus: "reported",
    });
    expect(result.estimateExceeded).toBe(true);
    expect(updates[0].actualCostMicros).toBe(79_236);
    expect(updates[0].failureReason).toBe("ESTIMATE_EXCEEDED");
  });

  it("keeps holding capacity when the cost was never reported", async () => {
    // The call happened and may have been charged. Releasing here would hand
    // out capacity that is already spent.
    const result = await commitReservation("br_1", {
      actualCostMicros: null,
      costStatus: "not_reported",
    });
    expect(result.estimateExceeded).toBe(false);
    expect(updates[0].status).toBe("reconciliation_pending");
  });
});

describe("the budget day", () => {
  it("is UTC, and the same for every ledger and reservation", () => {
    const justBefore = new Date("2026-08-06T23:59:59.999Z");
    const justAfter = new Date("2026-08-07T00:00:00.000Z");
    expect(budgetDay(justBefore)).toBe("2026-08-06");
    expect(budgetDay(justAfter)).toBe("2026-08-07");
    expect(budgetMonth(new Date("2026-08-31T23:59:59.999Z"))).toBe("2026-08");
    expect(budgetMonth(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09");
  });
});
