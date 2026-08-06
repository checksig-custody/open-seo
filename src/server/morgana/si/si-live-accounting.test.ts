import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — the job and the ledger describe one operation.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * Production showed a job row reading `actual_cost_micros = 0` beside ledger
 * rows reading 40440 for the same collection. `finishJob` was never passed a
 * cost, so both money columns took their default, and the two records of one
 * operation disagreed about whether it had cost anything. These cases pin the
 * single accounting object that now feeds the ledger, the job and the outcome.
 */

interface UsageCall {
  jobId?: string | null;
  endpointPath: string;
  costStatus?: string;
  actualCostMicros?: number;
  failed?: boolean;
}

interface Accounting {
  estimatedCostMicros: number;
  actualCostMicros: number;
  providerReportedCostMicros: number;
  costStatus: string;
  requests: number;
  meteredRequests: number;
  paidSubmissions: number;
  freeRequests: number;
}

interface JobPatch {
  status: string;
  skipReason?: string;
  accounting?: Accounting;
}

const collectDomainOverview = vi.fn();
const persistSnapshot = vi.fn();
const recordUsage = vi.fn<(input: UsageCall) => Promise<void>>();
const finishJob = vi.fn<(id: string, patch: JobPatch) => Promise<void>>();

vi.mock("./live-domain-collector", () => ({ collectDomainOverview }));
vi.mock("./store", () => ({ persistSnapshot }));
vi.mock("./ledger-store", () => ({ recordUsage }));
vi.mock("./job-store", () => ({ finishJob }));

const { CollectorCallError } = await import("./collection-log");
const { runLiveDomainRefresh } = await import("./refresh-live");

type Entity = Parameters<typeof runLiveDomainRefresh>[0]["entity"];

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

const collected = (
  calls: {
    endpointPath: string;
    cost: { micros: number | null; status: string };
  }[],
) => ({
  metrics: {
    organicTrafficEstimate: 381,
    organicKeywordCount: 21,
    backlinkCount: null,
    referringDomainCount: null,
    rankSignal: 2,
  },
  keywords: [{ keyword: "k" }],
  pages: [{ url: "u" }],
  calls,
  completeness: "complete",
  partialReason: null,
});

/** The three real Labs calls, priced as production priced them. */
const THREE_REPORTED = [
  {
    endpointPath: "v3/dataforseo_labs/google/domain_rank_overview/live",
    cost: { micros: 12120, status: "reported" },
  },
  {
    endpointPath: "v3/dataforseo_labs/google/ranked_keywords/live",
    cost: { micros: 14520, status: "reported" },
  },
  {
    endpointPath: "v3/dataforseo_labs/google/relevant_pages/live",
    cost: { micros: 13800, status: "reported" },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  collectDomainOverview.mockResolvedValue(collected(THREE_REPORTED));
  persistSnapshot.mockResolvedValue({ snapshotId: "ds_1", created: true });
  recordUsage.mockResolvedValue(undefined);
  finishJob.mockResolvedValue(undefined);
});

const patch = (): JobPatch | undefined => finishJob.mock.calls.at(-1)?.[1];
const ledgerActualTotal = () =>
  recordUsage.mock.calls
    .map((call) => call[0])
    .reduce((sum, row) => sum + (row.actualCostMicros ?? 0), 0);

describe("job and ledger agree", () => {
  it("gives the job the cost the ledger was written from", async () => {
    const result = await runLiveDomainRefresh(INPUT);
    // 12120 + 14520 + 13800, the real production figures.
    expect(ledgerActualTotal()).toBe(40440);
    expect(patch()?.accounting?.actualCostMicros).toBe(40440);
    expect(patch()?.accounting?.estimatedCostMicros).toBe(40440);
    expect(result.accounting.actualCostMicros).toBe(40440);
    // The defect this file exists for: the job used to say zero here.
    expect(patch()?.accounting?.actualCostMicros).not.toBe(0);
  });

  it("counts each call exactly once, in one place", async () => {
    const result = await runLiveDomainRefresh(INPUT);
    expect(recordUsage).toHaveBeenCalledTimes(3);
    expect(result.accounting.requests).toBe(3);
    expect(result.accounting.meteredRequests).toBe(3);
    expect(result.accounting.paidSubmissions).toBe(3);
    expect(result.accounting.freeRequests).toBe(0);
    // The ledger sum and the job total are the same money, not two tallies.
    expect(result.accounting.actualCostMicros).toBe(ledgerActualTotal());
  });

  it("correlates every ledger row with the job that caused it", async () => {
    await runLiveDomainRefresh(INPUT);
    const jobIds = recordUsage.mock.calls.map((call) => call[0].jobId);
    expect(jobIds).toEqual(["rj_1", "rj_1", "rj_1"]);
  });

  it("reports the provider figure as reported", async () => {
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.accounting.costStatus).toBe("reported");
    expect(result.accounting.providerReportedCostMicros).toBe(40440);
  });
});

describe("cost semantics", () => {
  it("treats an explicit provider zero as a measurement, not a gap", async () => {
    collectDomainOverview.mockResolvedValue(
      collected([
        { endpointPath: "labs/a", cost: { micros: 0, status: "zero" } },
        { endpointPath: "labs/b", cost: { micros: 0, status: "zero" } },
      ]),
    );
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.accounting.costStatus).toBe("zero");
    expect(result.accounting.actualCostMicros).toBe(0);
    expect(result.accounting.requests).toBe(2);
  });

  it("keeps an unreported cost out of the money column without calling it zero", async () => {
    collectDomainOverview.mockResolvedValue(
      collected([
        {
          endpointPath: "labs/a",
          cost: { micros: null, status: "not_reported" },
        },
      ]),
    );
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.accounting.costStatus).toBe("not_reported");
    expect(result.accounting.actualCostMicros).toBe(0);
    // Counted as a request even though no money is attributed to it.
    expect(result.accounting.requests).toBe(1);
    expect(patch()?.accounting?.costStatus).toBe("not_reported");
  });

  it("charges what IS known when only some calls reported", async () => {
    collectDomainOverview.mockResolvedValue(
      collected([
        { endpointPath: "labs/a", cost: { micros: 12120, status: "reported" } },
        {
          endpointPath: "labs/b",
          cost: { micros: null, status: "not_reported" },
        },
      ]),
    );
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.accounting.actualCostMicros).toBe(12120);
    expect(result.accounting.costStatus).toBe("reported");
  });

  it("never lets NaN reach any accounting field", async () => {
    collectDomainOverview.mockResolvedValue(
      collected([
        {
          endpointPath: "labs/a",
          cost: { micros: null, status: "not_reported" },
        },
        { endpointPath: "labs/b", cost: { micros: 12120, status: "reported" } },
      ]),
    );
    const result = await runLiveDomainRefresh(INPUT);
    for (const [key, value] of Object.entries(result.accounting)) {
      if (typeof value === "number") {
        expect(Number.isNaN(value), `${key} is NaN`).toBe(false);
        expect(Number.isFinite(value), `${key} is not finite`).toBe(true);
      }
    }
  });
});

describe("failure paths keep the accounting honest", () => {
  it("keeps provider spend in the ledger when persistence fails afterwards", async () => {
    persistSnapshot.mockRejectedValue(new Error("D1_ERROR: disk"));
    const result = await runLiveDomainRefresh(INPUT);
    // The three paid calls stay recorded — the money was spent regardless.
    expect(ledgerActualTotal()).toBe(40440);
    // And no fourth row invents a provider request that never failed.
    expect(recordUsage).toHaveBeenCalledTimes(3);
    expect(result.reason).toBe("collection_error");
    expect(patch()?.skipReason).toBe("collection_error");
  });

  it("attributes no cost to a job whose provider call itself failed", async () => {
    collectDomainOverview.mockRejectedValue(
      new CollectorCallError("labs/ranked_keywords", {
        cause: Object.assign(new Error("boom"), {
          name: "DataForSEOHttpError",
          code: "RATE_LIMITED",
        }),
      }),
    );
    const result = await runLiveDomainRefresh(INPUT);
    expect(result.reason).toBe("provider_error");
    // One request counted, no money attributed, and explicitly not "zero".
    expect(result.accounting.requests).toBe(1);
    expect(result.accounting.actualCostMicros).toBe(0);
    expect(result.accounting.costStatus).toBe("not_reported");
    expect(recordUsage.mock.calls[0]?.[0].jobId).toBe("rj_1");
  });

  it("does not double count when the same job is retried", async () => {
    // Two attempts of the same job: each records its own calls, and neither
    // inflates the other's total. The ledger upsert is keyed by job id, so a
    // retry accumulates against the same row rather than creating a second set.
    await runLiveDomainRefresh(INPUT);
    const firstTotal = ledgerActualTotal();
    vi.clearAllMocks();
    collectDomainOverview.mockResolvedValue(collected(THREE_REPORTED));
    persistSnapshot.mockResolvedValue({ snapshotId: "ds_1", created: false });
    const second = await runLiveDomainRefresh(INPUT);
    expect(firstTotal).toBe(40440);
    // The SECOND attempt reports its own operation's cost, not the running sum.
    expect(second.accounting.actualCostMicros).toBe(40440);
    expect(recordUsage).toHaveBeenCalledTimes(3);
  });

  it("records what a partial collection cost, because it was still billed", async () => {
    collectDomainOverview.mockResolvedValue({
      ...collected(THREE_REPORTED),
      keywords: [],
      pages: [],
      completeness: "partial",
      partialReason: "overview reported 21 organic keywords but ...",
    });
    await runLiveDomainRefresh(INPUT);
    expect(patch()?.status).toBe("failed");
    expect(patch()?.accounting?.actualCostMicros).toBe(40440);
  });
});
