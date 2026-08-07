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

const { recoverRankTask } = await import("./rank-collect-service");

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
  recordUsage.mockResolvedValue(undefined);
  recordRank.mockResolvedValue(true);
});

/**
 * Redeeming a receipt after automatic polling has stopped.
 *
 * The attempt cap exists so nothing polls forever; recovery exists because the
 * provider may deliver after we stopped asking — which is exactly what happened
 * in production, two minutes after the eighth attempt. The row must therefore
 * stay reachable, and redeeming it must stay free.
 */
describe("explicit recovery", () => {
  const exhausted = {
    ...TASK,
    status: "recovery_pending",
    providerTaskId: "provider-task-abc",
    attemptCount: 8,
  };

  it("redeems the stored receipt with one free fetch, on the same job", async () => {
    taskById.mockResolvedValue(exhausted);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "organic",
          rank_group: 3,
          rank_absolute: 4,
          domain: "www.checksig.com",
          url: "https://www.checksig.com/it/",
        },
      ],
      noResults: false,
    });

    const outcome = await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });

    expect(outcome.status).toBe("collected");
    expect(outcome.observations).toBe(1);
    // Free, and attributed to the submission it completes — a recovery is the
    // second half of one operation, not a new one.
    const usage = recordUsage.mock.calls[0]?.[0];
    expect(usage?.meteringClass).toBe("result_fetch");
    expect(usage?.actualCostMicros).toBe(0);
    expect(usage?.jobId).toBe(TASK.jobId);
    // The only thing it may never do.
    expect(postRankCheckTasks).not.toHaveBeenCalled();
    expect(markSucceeded).toHaveBeenCalled();
  });

  it("refuses a task that was already redeemed rather than writing it twice", async () => {
    taskById.mockResolvedValue({ ...exhausted, status: "succeeded" });
    const outcome = await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("ALREADY_SUCCEEDED");
    expect(fetchQueuedSerpItems).not.toHaveBeenCalled();
  });

  it("refuses a row with no receipt — there is nothing to redeem", async () => {
    taskById.mockResolvedValue({ ...exhausted, providerTaskId: null });
    const outcome = await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("MISSING_PROVIDER_TASK_ID");
    expect(fetchQueuedSerpItems).not.toHaveBeenCalled();
  });

  it("reports a still-pending provider without touching the attempt cap", async () => {
    taskById.mockResolvedValue(exhausted);
    fetchQueuedSerpItems.mockResolvedValue({ status: "pending" });
    const outcome = await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });
    expect(outcome.status).toBe("pending");
    expect(markRecoveryPending).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("leaves a parked row parked when the provider is still working", async () => {
    // `markWaiting` sets `waiting` and increments the attempt count, and the
    // automatic sweep selects `waiting` — so recovering a still-pending
    // `recovery_pending` task used to push it back into the sweep, where the
    // next tick immediately re-hit the cap and parked it again. Each cycle
    // burned a free `task_get` and a ledger row, and defeated the parked state.
    taskById.mockResolvedValue(exhausted);
    fetchQueuedSerpItems.mockResolvedValue({ status: "pending" });
    await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });
    expect(markWaiting).not.toHaveBeenCalled();
  });

  it("does resume a task that was merely waiting, not parked", async () => {
    // The guard is about the parked state specifically. An ordinary waiting row
    // still gets its backoff refreshed.
    taskById.mockResolvedValue({
      ...exhausted,
      status: "waiting",
      attemptCount: 2,
    });
    fetchQueuedSerpItems.mockResolvedValue({ status: "pending" });
    await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });
    expect(markWaiting).toHaveBeenCalled();
  });

  /**
   * The two paths share `collectOneTask` and differ only by whether the attempt
   * cap applies. This is the property that keeps that true: the same provider
   * payload must mean the same thing to both.
   */
  it("reads an unreachable provider the same way the sweep does", async () => {
    taskById.mockResolvedValue(exhausted);
    fetchQueuedSerpItems.mockRejectedValue(
      Object.assign(new Error("upstream"), {
        name: "AppError",
        code: "INTERNAL_ERROR",
      }),
    );
    const outcome = await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });
    // Not a provider verdict on either path, so not terminal on either path.
    expect(outcome.status).toBe("pending");
    expect(outcome.reason).toBe("provider_unreachable");
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("reads a provider verdict the same way the sweep does", async () => {
    taskById.mockResolvedValue(exhausted);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "failed",
      statusCode: 40201,
      message: "whatever the provider said",
    });
    const outcome = await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });
    expect(outcome.status).toBe("failed");
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "DATAFORSEO_TASK_FAILED" }),
    );
  });

  it("reads an expired task the same way the sweep does", async () => {
    taskById.mockResolvedValue(exhausted);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "failed",
      statusCode: 40100,
      message: "Task Not Found",
    });
    const outcome = await recoverRankTask({
      taskId: TASK.id,
      entities: [ENTITY],
      day: "2026-08-06",
    });
    expect(outcome.status).toBe("expired");
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "DATAFORSEO_TASK_EXPIRED" }),
    );
  });

  it("never submits, whatever the provider says", async () => {
    // Collection cannot reach `task_post` however it is invoked — the only
    // provider call in this file is a `task_get` against a stored receipt.
    for (const response of [
      { status: "pending" },
      { status: "failed", statusCode: 40201, message: "x" },
      { status: "failed", statusCode: 40100, message: "x" },
    ]) {
      taskById.mockResolvedValue(exhausted);
      fetchQueuedSerpItems.mockResolvedValue(response);
      await recoverRankTask({
        taskId: TASK.id,
        entities: [ENTITY],
        day: "2026-08-06",
      });
    }
    expect(postRankCheckTasks).not.toHaveBeenCalled();
  });

  it("says so when the task id is unknown", async () => {
    taskById.mockResolvedValue(null);
    const outcome = await recoverRankTask({
      taskId: "rt_nope",
      entities: [ENTITY],
      day: "2026-08-06",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("UNKNOWN_TASK");
  });
});
