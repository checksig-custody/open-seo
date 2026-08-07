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

/** A task that has been bought: it holds a receipt, so it is collectable. */
const submittedTask = {
  ...TASK,
  status: "submitted",
  providerTaskId: "provider-task-abc",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  claimRankTask.mockResolvedValue({ outcome: "claimed", task: { ...TASK } });
  resumable.mockReturnValue(false);
  recordUsage.mockResolvedValue(undefined);
  recordRank.mockResolvedValue(true);
  collectableTasks.mockResolvedValue([]);
});

/**
 * THE DEFECT THIS SECTION EXISTS FOR, observed in production on 2026-08-07.
 *
 * `fetchQueuedSerpItems` throws when the response ENVELOPE is unusable — a
 * 5xx, a rate limit, a body that will not parse. `codeForProvider` mapped
 * every unrecognised upstream code, `INTERNAL_ERROR` included, to
 * `DATAFORSEO_TASK_FAILED` with a `provider` origin, and the collector made
 * that terminal. So a transient failure to REACH DataForSEO was recorded as
 * DataForSEO's verdict ON the task, `markFailed` made the row invisible to
 * `collectableTasks`, and a SERP already paid for was stranded.
 *
 * Three tasks were marked failed that way. All three collected successfully
 * when asked again.
 */
describe("an unreachable provider is not a provider verdict", () => {
  const transportFailures = [
    ["a 5xx", "UPSTREAM_UNAVAILABLE"],
    ["a rate limit", "RATE_LIMITED"],
    ["an unusable envelope", "INTERNAL_ERROR"],
  ] as const;

  for (const [label, code] of transportFailures) {
    it(`keeps the task collectable after ${label}`, async () => {
      collectableTasks.mockResolvedValue([submittedTask]);
      fetchQueuedSerpItems.mockRejectedValue(
        Object.assign(new Error("upstream"), {
          name: "AppError",
          code,
        }),
      );
      const result = await collectReadyRankTasks({
        entities: [ENTITY],
        day: "2026-08-06",
        limit: 5,
      });
      expect(markFailed).not.toHaveBeenCalled();
      expect(result.pending).toBe(1);
      expect(result.failed).toBe(0);
      expect(markWaiting).toHaveBeenCalled();
    });
  }

  it("still parks it at the attempt cap rather than polling forever", async () => {
    collectableTasks.mockResolvedValue([{ ...submittedTask, attemptCount: 7 }]);
    fetchQueuedSerpItems.mockRejectedValue(
      Object.assign(new Error("upstream"), {
        name: "AppError",
        code: "INTERNAL_ERROR",
      }),
    );
    const result = await collectReadyRankTasks({
      entities: [ENTITY],
      day: "2026-08-06",
      limit: 5,
    });
    expect(result.recoveryPending).toBe(1);
    expect(markRecoveryPending).toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });
});

it("treats a provider-expired task as terminal, with its own code", async () => {
  // Distinct from a rejected task because the RECEIPT IS NOW WORTHLESS: the
  // provider no longer holds the result, so re-collecting can never succeed
  // and only a new purchase could. Recording it as a plain failure left
  // `resumable()` willing to re-fetch it forever.
  collectableTasks.mockResolvedValue([submittedTask]);
  fetchQueuedSerpItems.mockResolvedValue({
    status: "failed",
    statusCode: 40100,
    message: "Task Not Found",
  });
  const result = await collectReadyRankTasks({
    entities: [ENTITY],
    day: "2026-08-06",
    limit: 5,
  });
  expect(result.failed).toBe(1);
  expect(markFailed).toHaveBeenCalledWith(
    expect.objectContaining({
      origin: "provider",
      errorCode: "DATAFORSEO_TASK_EXPIRED",
    }),
  );
});
