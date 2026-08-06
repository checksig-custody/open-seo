import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — one SERP answers for every tracked entity.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Its own file because it pins two defects found against production rather than
 * in review: a tick with spend off wrote five synthetic positions into the
 * production database, and the same tick would have bought five identical SERPs
 * had spend been on — one per tracked entity, for one page containing all of
 * them.
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
const resumable = vi.fn();

vi.mock("@/server/lib/dataforseo/client", () => ({
  loadDataforseoSections: () =>
    Promise.resolve({ postRankCheckTasks, fetchQueuedSerpItems }),
}));
vi.mock("./ledger-store", () => ({ recordUsage }));
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
 * ONE SERP, EVERY COMPETITOR.
 *
 * A production tick with spend off wrote five synthetic positions into the
 * production database, and the same tick would have bought five identical SERPs
 * had spend been on — one per tracked entity, for one page that already
 * contains all of them. Both defects are pinned here.
 */
describe("one page, read for every entity", () => {
  const COMPETITOR = {
    ...ENTITY,
    id: "se_2",
    normalizedDomain: "conio.com",
    canonicalDomain: "conio.com",
    entityType: "competitor" as const,
  };
  const submittedTask = {
    ...TASK,
    status: "submitted",
    providerTaskId: "provider-task-abc",
  };

  it("records one observation per entity from a single fetch", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "organic",
          rank_group: 1,
          rank_absolute: 1,
          domain: "conio.com",
          url: "https://conio.com/",
        },
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
      entities: [ENTITY, COMPETITOR],
      day: "2026-08-06",
      limit: 5,
    });
    // Two observations, ONE fetch, and above all no second purchase.
    expect(result.observations).toBe(2);
    expect(fetchQueuedSerpItems).toHaveBeenCalledTimes(1);
    expect(postRankCheckTasks).not.toHaveBeenCalled();

    const byEntity = new Map(
      recordRank.mock.calls.map((call) => [call[0].entityId, call[0]]),
    );
    expect(byEntity.get("se_1")).toMatchObject({ rankGroup: 4 });
    expect(byEntity.get("se_2")).toMatchObject({ rankGroup: 1 });
  });

  it("records absence per entity without inventing a position", async () => {
    collectableTasks.mockResolvedValue([submittedTask]);
    fetchQueuedSerpItems.mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "organic",
          rank_group: 1,
          domain: "conio.com",
          url: "https://conio.com/",
        },
      ],
      noResults: false,
    });
    await collectReadyRankTasks({
      entities: [ENTITY, COMPETITOR],
      day: "2026-08-06",
      limit: 5,
    });
    const byEntity = new Map(
      recordRank.mock.calls.map((call) => [call[0].entityId, call[0]]),
    );
    expect(byEntity.get("se_1")).toMatchObject({
      rankGroup: null,
      rankAbsolute: null,
      rankingUrl: null,
    });
    expect(byEntity.get("se_2")).toMatchObject({ rankGroup: 1 });
  });
});
