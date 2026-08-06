import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — the ledger must outlive the snapshot.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * The provider calls happen before anything is written. Once they have, the
 * money is spent whether or not the result lands, so the ledger is recorded
 * FIRST and a persistence failure loses the result, never the record of what it
 * cost. The first live production run demonstrated the opposite order failing:
 * a snapshot written with real metrics, a job marked failed, and no ledger row.
 */

/** The one ledger field these cases interrogate. */
interface UsageCall {
  costStatus?: string;
  actualCostMicros?: number;
  endpointPath: string;
}

const collectDomainOverview = vi.fn();
const persistSnapshot = vi.fn();
const recordUsage = vi.fn<(input: UsageCall) => Promise<void>>();
const finishJob = vi.fn<(id: string, patch: JobPatch) => Promise<void>>();

vi.mock("./live-domain-collector", () => ({ collectDomainOverview }));
vi.mock("./store", () => ({ persistSnapshot }));
vi.mock("./ledger-store", () => ({ recordUsage }));
vi.mock("./job-store", () => ({ finishJob }));

// `collection-log` is deliberately NOT mocked: the classification it performs
// is the thing under test here, and stubbing it would assert only that the
// caller calls a stub. Its single side effect is a console line, silenced below.
const { CollectorCallError } = await import("./collection-log");
const { runLiveDomainRefresh } = await import("./refresh-live");

/** The job fields these cases interrogate. */
interface JobPatch {
  status: string;
  skipReason?: string;
  lastError?: string | null;
}

type Entity = Parameters<typeof runLiveDomainRefresh>[0]["entity"];

/**
 * A full entity row, because the type is the real one — building it out beats
 * casting a partial, which would let a field these paths depend on go missing
 * without the compiler noticing.
 */
const ENTITY: Entity = {
  id: "se_1",
  displayName: "CheckSig",
  canonicalDomain: "checksig.com",
  normalizedDomain: "checksig.com",
  entityType: "primary",
  enabled: true,
  priority: "high",
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

const INPUT = {
  entity: ENTITY,
  jobId: "rj_1",
  snapshotDate: "2026-08-06",
  keywordLimit: 10,
  pageLimit: 10,
};

const COLLECTED = {
  metrics: {
    organicTrafficEstimate: 381,
    organicKeywordCount: 21,
    backlinkCount: null,
    referringDomainCount: null,
    rankSignal: 2,
  },
  keywords: [{ keyword: "k" }],
  pages: [{ url: "u" }],
  calls: [
    {
      endpointPath: "labs/domain_rank_overview",
      cost: { micros: 2000, status: "reported" },
    },
    {
      endpointPath: "labs/ranked_keywords",
      cost: { micros: null, status: "not_reported" },
    },
    {
      endpointPath: "labs/relevant_pages",
      cost: { micros: 0, status: "zero" },
    },
  ],
  completeness: "complete",
  partialReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  collectDomainOverview.mockResolvedValue(COLLECTED);
  persistSnapshot.mockResolvedValue({ snapshotId: "ds_1", created: true });
  recordUsage.mockResolvedValue(undefined);
  finishJob.mockResolvedValue(undefined);
});

/** The patch handed to `finishJob` by the run under test. */
const jobPatch = (): JobPatch | undefined => finishJob.mock.calls.at(-1)?.[1];

describe("live refresh accounting", () => {
  it("records one ledger row per call, each with its own cost status", async () => {
    await runLiveDomainRefresh(INPUT);
    expect(recordUsage).toHaveBeenCalledTimes(3);
    const statuses = recordUsage.mock.calls.map((call) => call[0].costStatus);
    expect(statuses).toEqual(["reported", "not_reported", "zero"]);
  });

  it("sums only the costs the provider actually reported", async () => {
    const result = await runLiveDomainRefresh(INPUT);
    // 2000 + (not reported) + 0 — the missing one contributes nothing rather
    // than being guessed at.
    expect(result.costMicros).toBe(2000);
  });

  it("never passes a cost figure for a not_reported call", async () => {
    await runLiveDomainRefresh(INPUT);
    const notReported = recordUsage.mock.calls
      .map((call) => call[0])
      .find((arg) => arg.costStatus === "not_reported");
    expect(notReported?.actualCostMicros).toBeUndefined();
  });

  it("writes the ledger BEFORE the snapshot", async () => {
    const order: string[] = [];
    recordUsage.mockImplementation(() => {
      order.push("ledger");
      return Promise.resolve();
    });
    persistSnapshot.mockImplementation(() => {
      order.push("snapshot");
      return Promise.resolve({ snapshotId: "ds_1", created: true });
    });
    await runLiveDomainRefresh(INPUT);
    expect(order[0]).toBe("ledger");
    expect(order.at(-1)).toBe("snapshot");
  });

  it("keeps the ledger when the snapshot write fails", async () => {
    persistSnapshot.mockRejectedValue(new Error("D1_ERROR: disk"));
    const result = await runLiveDomainRefresh(INPUT);
    // The three paid calls are still on record — and ONLY those three. This
    // used to add a fourth row marking a failed paid_submission, which counted
    // a provider request that was never made: the calls had all succeeded and
    // it was D1 that failed.
    expect(recordUsage).toHaveBeenCalledTimes(3);
    // ...and the job says the collection failed rather than claiming success.
    expect(result.status).toBe("failed");
    expect(finishJob).toHaveBeenCalledWith(
      "rj_1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("does not fail the job merely because a cost was not reported", async () => {
    collectDomainOverview.mockResolvedValue({
      ...COLLECTED,
      calls: [
        {
          endpointPath: "labs/domain_rank_overview",
          cost: { micros: null, status: "not_reported" },
        },
      ],
    });
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.status).toBe("created");
    expect(result.costMicros).toBe(0);
  });

  it("marks a partial collection failed and re-claimable, with the reason", async () => {
    collectDomainOverview.mockResolvedValue({
      ...COLLECTED,
      keywords: [],
      pages: [],
      completeness: "partial",
      partialReason: "overview reported 21 organic keywords but ...",
    });
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("21 organic keywords");
    expect(finishJob).toHaveBeenCalledWith(
      "rj_1",
      expect.objectContaining({
        status: "failed",
        skipReason: "partial_result",
      }),
    );
  });
});

/**
 * WHY A FAILURE MUST DESCRIBE ITSELF.
 *
 * Two production failures on 2026-08-06 were recorded as
 * `skip_reason = 'provider_error'`, `last_error = NULL`, against an endpoint
 * chosen by a constant. Nothing in that row was evidence: the reason was a
 * guess, the endpoint was wrong whenever the failure was not the first call,
 * and there was no detail at all. Spend authority was switched back off because
 * the failures could not be explained, so this is not a logging nicety.
 */
describe("failure attribution", () => {
  const providerFailure = (code: string, endpoint = "labs/ranked_keywords") =>
    new CollectorCallError(endpoint, {
      cause: Object.assign(new Error("boom"), { name: "AppError", code }),
    });

  it("names the endpoint that threw, not the first one", async () => {
    collectDomainOverview.mockRejectedValue(
      providerFailure("VALIDATION_ERROR"),
    );
    await runLiveDomainRefresh(INPUT);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0].endpointPath).toBe(
      "labs/ranked_keywords",
    );
  });

  it("records the provider error class and code in last_error", async () => {
    collectDomainOverview.mockRejectedValue(
      providerFailure("VALIDATION_ERROR"),
    );
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.reason).toBe("provider_error");
    expect(jobPatch()?.skipReason).toBe("provider_error");
    expect(jobPatch()?.lastError).toBe(
      "provider labs/ranked_keywords AppError VALIDATION_ERROR",
    );
  });

  it("calls a local failure a collection error, not a provider one", async () => {
    persistSnapshot.mockRejectedValue(
      Object.assign(new Error("no such column"), { name: "D1Error" }),
    );
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.reason).toBe("collection_error");
    expect(jobPatch()?.skipReason).toBe("collection_error");
    expect(jobPatch()?.lastError).toBe("collection - D1Error none");
  });

  it("never lets provider text reach last_error", async () => {
    // The upstream client attaches the raw response body to its errors, and
    // that body echoes the request — target domain included.
    collectDomainOverview.mockRejectedValue(
      new CollectorCallError("labs/domain_rank_overview", {
        cause: Object.assign(
          new Error('{"tasks":[{"data":{"target":"checksig.com"}}]}'),
          { name: "AppError", code: "40501 invalid field: 'target'\nsecret" },
        ),
      }),
    );
    await runLiveDomainRefresh(INPUT);
    const recorded = jobPatch()?.lastError ?? "";
    expect(recorded).not.toContain("checksig.com");
    expect(recorded).not.toContain("\n");
    // The code survives in a form that still identifies the fault.
    expect(recorded).toContain("40501");
  });
});
