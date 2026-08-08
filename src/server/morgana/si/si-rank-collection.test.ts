import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — collecting a SERP that was already paid for.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Split from the submission cases because the two halves defend different
 * properties: submission must never buy twice, collection must never turn a
 * provider problem into an absence. `task_get` is free, so nothing here may
 * ever reach `task_post`.
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
interface RankWrite {
  entityId: string;
  rankGroup: number | null;
  rankAbsolute: number | null;
  rankingUrl: string | null;
}
const recordRank = vi.fn<(input: RankWrite) => Promise<boolean>>();
const claimRankTask = vi.fn();
const markSubmitting = vi.fn();
const markSubmitted = vi.fn();
const markWaiting = vi.fn();
const markStatus = vi.fn();
const markSucceeded = vi.fn();
const markFailed = vi.fn();
const markSkipped = vi.fn();
const collectableTasks = vi.fn();
const markRecoveryPending = vi.fn();
const taskById = vi.fn();
const resumable = vi.fn();

vi.mock("@/server/lib/dataforseo/client", () => ({
  loadDataforseoSections: () =>
    Promise.resolve({ postRankCheckTasks, fetchQueuedSerpItems }),
}));
vi.mock("./ledger-store", () => ({ recordUsage }));
// Collection is free and never reserves, but it shares a module with the
// submission path that does. Mocked so this suite does not pull in `@/db`.
vi.mock("./budget-authority", () => ({
  authorizePaidOperation: vi.fn(() =>
    Promise.resolve({ allowed: true, reservationId: "br_test" }),
  ),
  commitReservation: vi.fn(),
}));
vi.mock("./p2-store", () => ({ recordRank }));
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
  markRecoveryPending,
  taskById,
  resumable,
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

const { collectReadyRankTasks } = await import("./rank-collect-service");

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
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  claimRankTask.mockResolvedValue({ outcome: "claimed", task: { ...TASK } });
  resumable.mockReturnValue(false);
  recordUsage.mockResolvedValue(undefined);
  recordRank.mockResolvedValue(true);
  collectableTasks.mockResolvedValue([]);
});

describe("collection", () => {
  const submittedTask = {
    ...TASK,
    status: "submitted",
    providerTaskId: "provider-task-abc",
  };

  it("counts a result fetch as free, never as a paid submission", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "organic",
          rank_group: 4,
          rank_absolute: 6,
          domain: "www.checksig.com",
          url: "https://www.checksig.com/it/",
        },
      ],
      noResults: false,
    });
    await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    const call = recordUsage.mock.calls[0]?.[0];
    expect(call?.meteringClass).toBe("result_fetch");
    expect(call?.actualCostMicros).toBe(0);
    expect(postRankCheckTasks).not.toHaveBeenCalled();
  });

  it("refuses a task with no receipt instead of inventing a task id", async () => {
    // The receipt IS the authority to fetch: without a `provider_task_id` there
    // is no provider task to ask about, and a fixture row never gets one — which
    // is what keeps a fixture uncollectable without a second guard.
    collectableTasks.mockResolvedValue([{ ...TASK, providerTaskId: null }]);
    const result = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(fetchQueuedSerpItems).not.toHaveBeenCalled();
    expect(markSkipped).toHaveBeenCalledWith({
      id: TASK.id,
      errorCode: "MISSING_PROVIDER_TASK_ID",
    });
    expect(result.collected).toBe(0);
    expect(recordRank).not.toHaveBeenCalled();
  });

  it("names an unattributable result rather than dropping it silently", async () => {
    collectableTasks.mockResolvedValue([
      { ...submittedTask, entityId: "se_deleted" },
    ]);
    await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(fetchQueuedSerpItems).not.toHaveBeenCalled();
    expect(markSkipped).toHaveBeenCalledWith({
      id: TASK.id,
      errorCode: "UNKNOWN_ENTITY",
    });
  });

  it("stores the ranking with its provenance", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "organic",
          rank_group: 4,
          rank_absolute: 6,
          domain: "www.checksig.com",
          url: "https://www.checksig.com/it/",
        },
      ],
      noResults: false,
    });
    const result = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(result.observations).toBe(1);
    expect(recordRank).toHaveBeenCalledWith(
      expect.objectContaining({
        rankGroup: 4,
        rankAbsolute: 6,
        rankingDomain: "www.checksig.com",
        resultType: "organic",
        snapshotStatus: "complete",
        provider: "dataforseo",
        providerTaskId: "provider-task-abc",
      }),
    );
  });

  it("stores a read SERP with no match as absence, not as a failure", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "organic",
          rank_group: 1,
          domain: "competitor.it",
          url: "https://competitor.it/",
        },
      ],
      noResults: false,
    });
    await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(recordRank).toHaveBeenCalledWith(
      expect.objectContaining({
        rankGroup: null,
        rankAbsolute: null,
        rankingUrl: null,
      }),
    );
    expect(markSucceeded).toHaveBeenCalled();
  });

  it("keeps a pending task pending, and never records it as not found", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({ status: "pending" });
    const result = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(result.pending).toBe(1);
    expect(recordRank).not.toHaveBeenCalled();
    expect(markWaiting).toHaveBeenCalled();
  });

  it("stops polling at the cap without claiming the provider expired it", async () => {
    // This assertion used to demand `DATAFORSEO_TASK_EXPIRED` with a provider
    // origin, and production proved that wrong: the task abandoned at 16:35:24Z
    // was completed by DataForSEO at 16:37:29Z. Running out of LOCAL attempts is
    // a fact about our polling, not about the provider.
    collectableTasks.mockResolvedValue([{ ...submittedTask, attemptCount: 7 }]);
    fetchQueuedSerpItems.mockResolvedValue({ status: "pending" });
    const result = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    // Counted as recovery-pending, not failed: nothing went wrong at the
    // provider and the receipt is still good. Reporting it as a failure is what
    // made an operator believe a paid SERP had been lost.
    expect(result.recoveryPending).toBe(1);
    expect(result.failed).toBe(0);
    expect(markRecoveryPending).toHaveBeenCalledWith({
      id: TASK.id,
      endpoint: "v3/serp/google/organic/task_get/advanced",
    });
    // Never `failed`: a failed row is unreachable, and this one still holds a
    // valid receipt for a SERP that has been paid for.
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("keeps a recovery-pending task out of the automatic sweep", async () => {
    // The cap exists so nothing polls forever. Recovery is deliberate, so the
    // sweep must not pick the row back up on the next tick.
    collectableTasks.mockResolvedValue([]);
    const result = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(fetchQueuedSerpItems).not.toHaveBeenCalled();
    expect(result.collected + result.pending + result.failed).toBe(0);
  });

  it("records a provider task failure as a provider fault, not an absence", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "failed",
      statusCode: 40501,
      message: "whatever the provider said",
    });
    await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(recordRank).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "provider",
        errorCode: "DATAFORSEO_TASK_FAILED",
      }),
    );
  });

  it("classifies a malformed response as invalid, and does not condemn the task", async () => {
    // A shape we cannot parse says nothing about the SERP. The receipt is still
    // valid and the task must stay collectable, so this is not terminal — the
    // attempt cap will park it if it keeps happening.
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockRejectedValue(
      Object.assign(new Error("bad shape"), { name: "ZodError" }),
    );
    const result = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(markFailed).not.toHaveBeenCalled();
    expect(result.pending).toBe(1);
    expect(markWaiting).toHaveBeenCalled();
  });

  it("keeps the receipt when only our own write fails", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "organic",
          rank_group: 4,
          domain: "checksig.com",
          url: "https://checksig.com/",
        },
      ],
      noResults: false,
    });
    recordRank.mockRejectedValue(new Error("D1_ERROR: disk"));
    const result = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(result.failed).toBe(1);
    // Persistence, not provider — the SERP arrived intact.
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "persistence",
        errorCode: "PERSISTENCE_FAILED",
      }),
    );
  });

  it("is idempotent when the same task is collected twice", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "organic",
          rank_group: 4,
          domain: "checksig.com",
          url: "https://checksig.com/",
        },
      ],
      noResults: false,
    });
    // The observation dedupe key rejects the second write.
    recordRank.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const first = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    const second = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(first.observations).toBe(1);
    expect(second.observations).toBe(0);
    // Both attempts still succeed — a duplicate is not an error — and neither
    // one bought anything.
    expect(second.collected).toBe(1);
    expect(postRankCheckTasks).not.toHaveBeenCalled();
  });

  it("never lets a NaN reach the accounting", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [],
      noResults: true,
    });
    await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    for (const [call] of recordUsage.mock.calls) {
      expect(Number.isNaN(call.actualCostMicros ?? 0)).toBe(false);
    }
  });
});
