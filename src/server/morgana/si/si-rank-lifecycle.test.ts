import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — the SERP task lifecycle and its accounting.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * The property every case here defends: **one SERP is bought at most once.**
 * A queued SERP is charged at submission and collected later for free, so every
 * way the system can be asked twice — a doubled tick, a retry after a failed
 * write, a re-claim of a finished task — must produce a fetch and not a
 * purchase.
 */

interface UsageCall {
  jobId?: string | null;
  endpointPath: string;
  meteringClass: string;
  costStatus?: string;
  actualCostMicros?: number;
  failed?: boolean;
}

const postRankCheckTasks =
  vi.fn<(input: { tasks: unknown[] }) => Promise<unknown>>();
const fetchQueuedSerpItems = vi.fn();
const recordUsage = vi.fn<(input: UsageCall) => Promise<void>>();
const recordRank = vi.fn();
const claimRankTask = vi.fn();
const markSubmitting = vi.fn();
const markSubmitted = vi.fn();
const markWaiting = vi.fn();
const markStatus = vi.fn();
const markSucceeded = vi.fn();
const markFailed = vi.fn();
const markSkipped = vi.fn();
const collectableTasks = vi.fn();
const resumable = vi.fn();
const rankTaskDedupeKey = vi.fn(() => "tk_1|2026-08-07|2380|it|desktop|google");
interface AuthorizeCall {
  collector: string;
  operationType: string;
  worstCaseMicros: number;
  idempotencyKey: string;
  subject?: string | null;
  subjectScope?: number | null;
  jobId?: string | null;
  operationId?: string | null;
}
const authorizePaidOperation =
  vi.fn<
    (
      config: unknown,
      input: AuthorizeCall,
    ) => Promise<{ allowed: boolean; reservationId?: string; code?: string }>
  >();
const commitReservation = vi.fn();

vi.mock("@/server/lib/dataforseo/client", () => ({
  loadDataforseoSections: () =>
    Promise.resolve({ postRankCheckTasks, fetchQueuedSerpItems }),
}));
vi.mock("./ledger-store", () => ({ recordUsage }));
vi.mock("./p2-store", () => ({ recordRank }));
vi.mock("./budget-authority", () => ({
  authorizePaidOperation,
  commitReservation,
}));
vi.mock("./rank-task-store", () => ({
  claimRankTask,
  markSubmitting,
  markSubmitted,
  markWaiting,
  markStatus,
  markSucceeded,
  markFailed,
  markSkipped,
  collectableTasks,
  resumable,
  rankTaskDedupeKey,
}));
// The account circuit breaker reaches D1, and these suites keep the collector
// module graph free of it deliberately — every db-touching dependency here is
// mocked so the collector can be exercised outside the Workers runtime. Its own
// behaviour is pinned in `si-provider-circuit.test.ts`; what matters here is
// that an unobserved provider does NOT block, which is the production default
// before the first call.
vi.mock("./provider-circuit", () => ({
  observeProviderError: vi.fn(async () => ({
    kind: "none",
    statusCode: null,
    sanitizedMessage: null,
  })),
  providerBlock: vi.fn(async () => ({ blocked: false })),
}));

const { submitDueRankTask, WORST_CASE_SUBMISSION_MICROS } =
  await import("./rank-live-service");
const { readPhase0Config } = await import("../phase0-env");
const { rankPreflight } = await import("./rank-preflight");

const ENTITY = {
  id: "se_1",
  displayName: "CheckSig",
  canonicalDomain: "checksig.com",
  normalizedDomain: "checksig.com",
  entityType: "primary" as const,
  enabled: true,
  priority: "high" as const,
  includeSubdomains: false,
  locationCode: 2380,
  languageCode: "it",
  refreshIntervalHours: 24,
  backlinkIntervalHours: 168,
  lastRefreshedAt: null,
  lastBacklinkRefreshedAt: null,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
  disabledAt: null,
};

const KEYWORD = {
  id: "tk_1",
  keyword: "custodia bitcoin",
  locationCode: 2380,
  languageCode: "it",
};

/** Production, credential present, spend on, caps set — the authorised state. */
const LIVE_ENV = {
  SEARCH_INTELLIGENCE_ENABLED: "true",
  SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
  SEARCH_INTELLIGENCE_ENVIRONMENT: "production",
  SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
  SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2.00",
  DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY: "present",
};

const submitInput = (overrides: Record<string, unknown> = {}) => ({
  config: readPhase0Config(LIVE_ENV),
  providerStatus: "live" as const,
  entity: ENTITY,
  keyword: KEYWORD,
  jobId: "rj_1",
  day: "2026-08-06",
  dailySpentMicros: 121_320,
  monthlySpentMicros: 121_320,
  now: new Date("2026-08-06T12:00:00.000Z"),
  ...overrides,
});

const TASK = {
  id: "rt_1",
  jobId: "rj_1",
  trackedKeywordId: "tk_1",
  entityId: "se_1",
  providerTaskId: null as string | null,
  status: "queued",
  attemptCount: 0,
  keyword: "custodia bitcoin",
  targetDomain: "checksig.com",
  locationCode: 2380,
  languageCode: "it",
  device: "desktop" as const,
  searchEngine: "google",
  collectionWindow: "2026-08-06",
};

/** A post that was answered and billed, then found to carry no task id. */
const taskless = (micros: number, costStatus: string) =>
  Object.assign(new Error("task_post returned no task id"), {
    name: "DataForSEOTaskPostError",
    code: "DATAFORSEO_TASK_FAILED",
    // What the response actually said it cost, read before the failure.
    accounting: {
      requests: 1,
      meteredRequests: 1,
      paidSubmissions: 1,
      resultFetchRequests: 0,
      estimatedCostMicros: micros,
      actualCostMicros: micros,
      costStatus,
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  claimRankTask.mockResolvedValue({ outcome: "claimed", task: { ...TASK } });
  resumable.mockReturnValue(false);
  postRankCheckTasks.mockResolvedValue({
    data: [{ taskId: "provider-task-abc", keyword: "custodia bitcoin" }],
    billing: {
      path: ["v3", "serp", "google", "organic", "task_post"],
      costUsd: 0.0006,
    },
  });
  recordUsage.mockResolvedValue(undefined);
  recordRank.mockResolvedValue(true);
  collectableTasks.mockResolvedValue([]);
  authorizePaidOperation.mockResolvedValue({
    allowed: true,
    reservationId: "br_test",
  });
});

describe("submission", () => {
  it("buys one SERP and stores the receipt", async () => {
    const result = await submitDueRankTask(submitInput());
    expect(result.status).toBe("submitted");
    expect(postRankCheckTasks).toHaveBeenCalledTimes(1);
    // One task per submission: a batch would make per-keyword cost a division.
    expect(postRankCheckTasks.mock.calls[0]?.[0].tasks).toHaveLength(1);
    expect(markSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ providerTaskId: "provider-task-abc" }),
    );
  });

  it("accounts the submission as a paid submission, with the provider's cost", async () => {
    const result = await submitDueRankTask(submitInput());
    expect(result.accounting.paidSubmissions).toBe(1);
    expect(result.accounting.actualCostMicros).toBe(600);
    expect(result.accounting.costStatus).toBe("reported");
    const call = recordUsage.mock.calls[0]?.[0];
    expect(call?.meteringClass).toBe("paid_submission");
    expect(call?.jobId).toBe("rj_1");
  });

  it("writes the ledger before the receipt", async () => {
    const order: string[] = [];
    recordUsage.mockImplementation(() => {
      order.push("ledger");
      return Promise.resolve();
    });
    markSubmitted.mockImplementation(() => {
      order.push("receipt");
      return Promise.resolve();
    });
    await submitDueRankTask(submitInput());
    expect(order).toEqual(["ledger", "receipt"]);
  });

  it("refuses to buy a second SERP for work already in flight", async () => {
    claimRankTask.mockResolvedValue({
      outcome: "duplicate",
      task: {
        ...TASK,
        status: "submitted",
        providerTaskId: "provider-task-abc",
      },
    });
    const result = await submitDueRankTask(submitInput());
    expect(result.status).toBe("duplicate");
    expect(result.reason).toBe("DUPLICATE_PENDING_TASK");
    expect(postRankCheckTasks).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("re-fetches rather than re-buys when a revived task still holds a receipt", async () => {
    // The SERP was bought and delivered; only our own write failed. Buying it
    // again would be paying twice for one page.
    claimRankTask.mockResolvedValue({
      outcome: "claimed",
      task: { ...TASK, providerTaskId: "provider-task-abc", status: "queued" },
    });
    resumable.mockReturnValue(true);
    const result = await submitDueRankTask(submitInput());
    expect(result.status).toBe("duplicate");
    expect(postRankCheckTasks).not.toHaveBeenCalled();
    expect(result.accounting.paidSubmissions).toBe(0);
  });

  it("counts a failed submission without attributing money to it", async () => {
    postRankCheckTasks.mockRejectedValue(
      Object.assign(new Error("boom"), {
        name: "DataForSEOHttpError",
        code: "RATE_LIMITED",
      }),
    );
    const result = await submitDueRankTask(submitInput());
    expect(result.status).toBe("failed");
    expect(result.accounting.requests).toBe(1);
    expect(result.accounting.actualCostMicros).toBe(0);
    expect(result.accounting.costStatus).toBe("not_reported");
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "DATAFORSEO_RATE_LIMITED" }),
    );
  });
});

/**
 * The SERP path used to CHECK the budget and then spend, which is not a guard:
 * two ticks reading the same remainder both proceed and the overrun is found
 * afterwards. That is the 2026-08-06 incident the budget authority exists to
 * prevent, and until 2026-08-07 only Backlinks actually reserved.
 */
describe("reserving before spending", () => {
  it("holds capacity before the provider is called", async () => {
    await submitDueRankTask(submitInput());
    expect(authorizePaidOperation).toHaveBeenCalledTimes(1);
    const call = authorizePaidOperation.mock.calls[0]?.[1];
    expect(call).toMatchObject({
      collector: "phase2",
      operationType: "serp_task_post",
      worstCaseMicros: WORST_CASE_SUBMISSION_MICROS,
      subject: "custodia bitcoin",
      operationId: "rt_1",
      jobId: "rj_1",
    });
    // The dedupe key already names exactly one purchase — this keyword, this
    // window, this market and device — so it is the idempotency key too.
    expect(call?.idempotencyKey).toBe(
      "serp|tk_1|2026-08-07|2380|it|desktop|google",
    );
  });

  it("commits the reservation with what the provider actually charged", async () => {
    await submitDueRankTask(submitInput());
    expect(commitReservation).toHaveBeenCalledWith(
      "br_test",
      expect.objectContaining({
        actualCostMicros: 600,
        costStatus: "reported",
      }),
    );
  });

  it("does not spend when the authority refuses", async () => {
    authorizePaidOperation.mockResolvedValueOnce({
      allowed: false,
      code: "denied_daily_cap",
    });
    const result = await submitDueRankTask(submitInput());
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("denied_daily_cap");
    // The point of reserving first: nothing was bought.
    expect(postRankCheckTasks).not.toHaveBeenCalled();
    expect(markSubmitting).not.toHaveBeenCalled();
    // And the refusal is attributed to the budget, not to collection.
    expect(markSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ errorOrigin: "budget" }),
    );
  });

  it("keeps holding capacity when a failed post may still have been charged", async () => {
    postRankCheckTasks.mockRejectedValueOnce(new Error("502 bad gateway"));
    const result = await submitDueRankTask(submitInput());
    expect(result.status).toBe("failed");
    // Nothing came back to read, so nothing is known. `not_reported` is what
    // makes the reservation stay pending rather than release capacity for money
    // that may already be spent.
    expect(commitReservation).toHaveBeenCalledWith(
      "br_test",
      expect.objectContaining({
        actualCostMicros: null,
        costStatus: "not_reported",
      }),
    );
  });

  /**
   * THE 6 000 µUSD THIS TEST EXISTS FOR. On 2026-08-07 two submissions came
   * back answered but with no task id. `submitRankTask` had already read the
   * billing block and attached the accounting to the error it threw — and the
   * handler discarded it and wrote `not_reported`. Two reservations went to
   * `reconciliation_pending` holding 3 000 µUSD each, a hard and never-waivable
   * release blocker, and the evidence that could have cleared them was gone.
   */
  it("uses the cost the provider stated when a post fails after answering", async () => {
    postRankCheckTasks.mockRejectedValueOnce(taskless(600, "reported"));
    const result = await submitDueRankTask(submitInput());
    expect(result.status).toBe("failed");
    // A stated cost is a measurement. The reservation closes on it instead of
    // holding capacity forever.
    expect(commitReservation).toHaveBeenCalledWith(
      "br_test",
      expect.objectContaining({
        actualCostMicros: 600,
        costStatus: "reported",
      }),
    );
    expect(recordUsage.mock.calls[0]?.[0].actualCostMicros).toBe(600);
  });

  it("treats a stated zero as zero, not as unknown", async () => {
    postRankCheckTasks.mockRejectedValueOnce(taskless(0, "zero"));
    await submitDueRankTask(submitInput());
    // "The provider says this cost nothing" and "nobody knows what this cost"
    // are different facts, and only the second may hold capacity.
    expect(commitReservation).toHaveBeenCalledWith(
      "br_test",
      expect.objectContaining({ actualCostMicros: 0, costStatus: "zero" }),
    );
  });

  it("ignores a malformed accounting rather than trusting it", async () => {
    const bad = { accounting: { costStatus: 42 } };
    postRankCheckTasks.mockRejectedValueOnce(
      Object.assign(new Error("boom"), bad),
    );
    await submitDueRankTask(submitInput());
    expect(commitReservation).toHaveBeenCalledWith(
      "br_test",
      expect.objectContaining({ costStatus: "not_reported" }),
    );
  });

  it("reserves nothing for a duplicate, which buys nothing", async () => {
    claimRankTask.mockResolvedValueOnce({
      outcome: "duplicate",
      task: { ...TASK, providerTaskId: "provider-task-abc" },
    });
    const result = await submitDueRankTask(submitInput());
    expect(result.status).toBe("duplicate");
    expect(authorizePaidOperation).not.toHaveBeenCalled();
  });
});

describe("pre-flight", () => {
  it("refuses when the worst case would breach the daily cap", async () => {
    const result = await submitDueRankTask(
      submitInput({
        dailySpentMicros: 200_000 - WORST_CASE_SUBMISSION_MICROS + 1,
      }),
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("daily_budget_insufficient");
    // No claim, no call, no cost, no row.
    expect(claimRankTask).not.toHaveBeenCalled();
    expect(postRankCheckTasks).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("refuses a fixture path in production rather than inventing a rank", async () => {
    const result = await submitDueRankTask(
      submitInput({ providerStatus: "fixture" }),
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("fixture_path_unavailable");
    expect(postRankCheckTasks).not.toHaveBeenCalled();
  });

  it("refuses when paid calls are off", async () => {
    const env = {
      ...LIVE_ENV,
      SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "false",
    };
    const result = await submitDueRankTask(
      submitInput({ config: readPhase0Config(env) }),
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("paid_calls_disabled");
  });

  it("cannot even be configured with paid calls on and a zero cap", () => {
    // Defence in depth: the pre-flight refuses a zero cap, but env validation
    // never lets that configuration boot in the first place, so the refusal is
    // a backstop rather than the only guard. Asserting the outer one here keeps
    // the inner one honest — see the direct pre-flight test below.
    const env = { ...LIVE_ENV, SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0" };
    expect(() => readPhase0Config(env)).toThrow();
  });

  it("refuses a zero cap when one reaches it anyway", () => {
    const config = readPhase0Config({
      ...LIVE_ENV,
      SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "false",
      SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0",
      SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "0",
    });
    const result = rankPreflight({
      // Paid calls forced on for this check only, so the cap branch is the one
      // under test rather than the flag branch that precedes it.
      config: { ...config, SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true" },
      providerStatus: "live",
      dailySpentMicros: 0,
      monthlySpentMicros: 0,
      worstCaseCostMicros: WORST_CASE_SUBMISSION_MICROS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cap_not_set");
  });
});
