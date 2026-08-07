import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — search volume, and the difference between
 * "zero" and "we were not told".
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Every case here exists because the two are one `??` apart in the source and
 * opposite in meaning: a volume of zero says nobody searches this keyword, and
 * a null says nobody has measured it. The first may be weighted; the second may
 * not, and pretending otherwise would put an invented number into an
 * opportunity score and a share of search where nothing could tell it from a
 * measurement.
 */

const fetchKeywordOverview = vi.fn();
const recordUsage = vi.fn();
const ledgerTotals = vi.fn();
const listTrackedKeywords = vi.fn();
const saveVolumeSnapshot = vi.fn();
const updateKeywordVolume = vi.fn();

vi.mock("@/server/lib/dataforseo/client", () => ({
  loadDataforseoSections: () => Promise.resolve({ fetchKeywordOverview }),
}));
vi.mock("./budget-authority", () => ({
  globalSpend: vi.fn(() =>
    Promise.resolve({
      dailyActualMicros: 0,
      monthlyActualMicros: 0,
      openReservationsMicros: 0,
    }),
  ),
  authorizePaidOperation: vi.fn(() =>
    Promise.resolve({ allowed: true, reservationId: "br_test" }),
  ),
  commitReservation: vi.fn(),
  releaseReservation: vi.fn(),
}));
vi.mock("./ledger-store", () => ({ recordUsage, ledgerTotals }));
vi.mock("./p2-store", () => ({ listTrackedKeywords }));
vi.mock("./keyword-volume-store", () => ({
  saveVolumeSnapshot,
  updateKeywordVolume,
  latestVolumeSnapshots: vi.fn(),
  volumeSnapshotsForWindow: vi.fn(),
}));

const { collectKeywordVolumes, normalizeOverviewItem } =
  await import("./keyword-volume-collector");
const { refreshKeywordVolumes } = await import("./keyword-volume-service");
const { globalSpend } = await import("./budget-authority");
const { readPhase0Config } = await import("../phase0-env");

const KEYWORD = {
  id: "tk_1",
  keyword: "custodia bitcoin",
  normalizedKeyword: "custodia bitcoin",
  locationCode: 2380,
  languageCode: "it",
  trackingEnabled: true,
  priority: "critical",
  clusterId: null,
  searchVolume: null,
};

interface OverviewInfo {
  search_volume?: number | string | null;
  cpc?: number | null;
  competition?: number | null;
  competition_level?: string | null;
}

const item = (info: OverviewInfo = {}) => ({
  keyword: "custodia bitcoin",
  keyword_info: {
    search_volume: 480,
    cpc: 1.25,
    competition: 0.42,
    competition_level: "MEDIUM",
    ...info,
  },
  keyword_properties: { keyword_difficulty: 37 },
  search_intent_info: { main_intent: "commercial" },
});

const billing = { path: ["v3", "labs", "keyword_overview"], costUsd: 0.0101 };

/** The first ledger write, typed — the assertions below are about money. */
interface UsageCall {
  costStatus?: string;
  actualCostMicros?: number;
}

const usageCall = (): UsageCall => {
  const call: unknown = recordUsage.mock.calls[0]?.[0];
  return typeof call === "object" && call !== null ? (call as UsageCall) : {};
};

const liveEnv = {
  SEARCH_INTELLIGENCE_ENABLED: "true",
  SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
  SEARCH_INTELLIGENCE_ENVIRONMENT: "production",
  SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
  SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2.00",
  DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY: "present",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  ledgerTotals.mockResolvedValue({ actualCostMicros: 0 });
  listTrackedKeywords.mockResolvedValue([KEYWORD]);
  saveVolumeSnapshot.mockResolvedValue({ id: "kv_1", created: true });
  updateKeywordVolume.mockResolvedValue(undefined);
});

describe("normalization", () => {
  it("keeps a positive volume, with its competition and CPC in micro-USD", () => {
    const row = normalizeOverviewItem(item(), "custodia bitcoin");
    expect(row.searchVolume).toBe(480);
    expect(row.competition).toBe(0.42);
    expect(row.costPerClickMicros).toBe(1_250_000);
    expect(row.keywordDifficulty).toBe(37);
    expect(row.snapshotStatus).toBe("complete");
  });

  it("keeps a measured zero as zero", () => {
    // A real answer: nobody searches this. It is eligible data, not missing.
    const row = normalizeOverviewItem(
      item({ search_volume: 0 }),
      "custodia bitcoin",
    );
    expect(row.searchVolume).toBe(0);
    expect(row.snapshotStatus).toBe("complete");
  });

  it("keeps an unstated volume null and says the provider had none", () => {
    const row = normalizeOverviewItem(
      item({ search_volume: null }),
      "custodia bitcoin",
    );
    expect(row.searchVolume).toBeNull();
    expect(row.snapshotStatus).toBe("no_data");
    expect(row.snapshotStatusReason).toContain("no search volume");
  });

  it("refuses a malformed payload rather than coercing it", () => {
    const row = normalizeOverviewItem(
      {
        keyword: "custodia bitcoin",
        keyword_info: {
          search_volume: "many",
          cpc: Number.NaN,
          competition: 42,
        },
      },
      "custodia bitcoin",
    );
    expect(row.searchVolume).toBeNull();
    // NaN must never reach a money column, and a competition outside 0..1 is
    // not a ratio whatever the provider calls it.
    expect(row.costPerClickMicros).toBeNull();
    expect(row.competition).toBeNull();
  });

  it("survives a response with no keyword_info at all", () => {
    const row = normalizeOverviewItem({ keyword: "x" }, "x");
    expect(row.searchVolume).toBeNull();
    expect(row.costPerClickMicros).toBeNull();
  });
});

describe("collection", () => {
  it("asks once for the whole batch, because the request is flat-priced", async () => {
    fetchKeywordOverview.mockResolvedValue({ data: [item()], billing });
    const outcome = await collectKeywordVolumes({
      keywords: ["custodia bitcoin", "custodia crypto"],
      locationCode: 2380,
      languageCode: "it",
    });
    expect(fetchKeywordOverview).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("completed");
  });

  it("leaves a keyword the provider did not answer about absent, not zero", async () => {
    fetchKeywordOverview.mockResolvedValue({ data: [item()], billing });
    const outcome = await collectKeywordVolumes({
      keywords: ["custodia bitcoin", "custodia crypto"],
      locationCode: 2380,
      languageCode: "it",
    });
    if (outcome.status !== "completed") throw new Error("expected completion");
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0].keyword).toBe("custodia bitcoin");
  });

  it("reports a provider error as a failure, never as a batch of zeroes", async () => {
    fetchKeywordOverview.mockRejectedValue(new Error("provider exploded"));
    const outcome = await collectKeywordVolumes({
      keywords: ["custodia bitcoin"],
      locationCode: 2380,
      languageCode: "it",
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failure.origin).toBe("provider");
    // Counted as a request whose cost is unknown: it may have been charged and
    // the response cannot say.
    expect(outcome.accounting.costStatus).toBe("not_reported");
    expect(outcome.accounting.requests).toBe(1);
  });
});

describe("the refresh, end to end", () => {
  const run = (env: Record<string, string>, providerStatus = "live") =>
    refreshKeywordVolumes(readPhase0Config(env), env, {
      providerStatus,
      limit: 10,
    });

  it("stores a measurement, updates the read model and ledgers the cost", async () => {
    fetchKeywordOverview.mockResolvedValue({ data: [item()], billing });
    const result = await run(liveEnv);

    expect(result.status).toBe("collected");
    expect(result.withVolume).toBe(1);
    expect(result.stored).toBe(1);
    expect(saveVolumeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        searchVolume: 480,
        source: "dataforseo",
        snapshotStatus: "complete",
      }),
    );
    expect(updateKeywordVolume).toHaveBeenCalledWith("tk_1", 480);
    const usage = usageCall();
    expect(usage?.costStatus).toBe("reported");
    expect(usage?.actualCostMicros).toBe(10_100);
    expect(Number.isNaN(usage?.actualCostMicros)).toBe(false);
  });

  it("writes a measured zero to the read model — it is data", async () => {
    fetchKeywordOverview.mockResolvedValue({
      data: [item({ search_volume: 0 })],
      billing,
    });
    const result = await run(liveEnv);
    expect(result.withVolume).toBe(1);
    expect(updateKeywordVolume).toHaveBeenCalledWith("tk_1", 0);
  });

  it("never overwrites a known volume with an unknown one", async () => {
    fetchKeywordOverview.mockResolvedValue({
      data: [item({ search_volume: null })],
      billing,
    });
    const result = await run(liveEnv);
    expect(result.noData).toBe(1);
    expect(result.withVolume).toBe(0);
    // The snapshot records that we asked and were told nothing; the read model
    // keeps whatever better answer it already had.
    expect(saveVolumeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        searchVolume: null,
        snapshotStatus: "no_data",
      }),
    );
    expect(updateKeywordVolume).not.toHaveBeenCalled();
  });

  it("counts a repeat in the same window as stored zero, not as new history", async () => {
    fetchKeywordOverview.mockResolvedValue({ data: [item()], billing });
    saveVolumeSnapshot.mockResolvedValue({ id: "kv_1", created: false });
    const result = await run(liveEnv);
    expect(result.stored).toBe(0);
    expect(result.withVolume).toBe(1);
  });

  it("ledgers a failed call without attributing money to it", async () => {
    fetchKeywordOverview.mockRejectedValue(new Error("boom"));
    const result = await run(liveEnv);
    expect(result.status).toBe("failed");
    const usage = usageCall();
    expect(usage?.costStatus).toBe("not_reported");
    expect(usage?.actualCostMicros).toBeUndefined();
    expect(saveVolumeSnapshot).not.toHaveBeenCalled();
  });

  it("refuses to spend when paid calls are off, and writes no fixture volume", async () => {
    const result = await refreshKeywordVolumes(
      readPhase0Config({
        ...liveEnv,
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "false",
      }),
      liveEnv,
      { providerStatus: "fixture", limit: 10 },
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("VOLUME_PREFLIGHT_FAILED");
    expect(fetchKeywordOverview).not.toHaveBeenCalled();
    expect(saveVolumeSnapshot).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("refuses when the worst case would not fit inside the daily cap", async () => {
    // 0.19 spent of a 0.20 cap: one more request could not fit, and a cap
    // respected on average is not a cap. The figure now comes from the GLOBAL
    // authority — the sum of every ledger — rather than from this collector's
    // own, which is the whole point of the guard.
    // Every field stated rather than three asserted into place: the guard reads
    // the caps and the availability as well, and a partial object cast to the
    // whole type hid which of them the refusal actually turned on.
    vi.mocked(globalSpend).mockResolvedValue({
      day: "2026-08-06",
      month: "2026-08",
      dailyActualMicros: 190_000,
      monthlyActualMicros: 190_000,
      openReservationsMicros: 0,
      dailyCapMicros: 200_000,
      monthlyCapMicros: 2_000_000,
      availableDailyMicros: 10_000,
      availableMonthlyMicros: 1_810_000,
      perCollector: [],
      overDailyCap: false,
      overMonthlyCap: false,
      unexpectedSpendDetected: false,
      reconciliationPending: 0,
    });
    const result = await run(liveEnv);
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("daily_budget_insufficient");
    expect(fetchKeywordOverview).not.toHaveBeenCalled();
  });
});
