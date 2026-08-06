import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — phase 1 collector: cost, scope, completeness.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * Every case here comes from something the first real production run got wrong.
 * The provider is mocked because the questions are all about MAPPING, and
 * asking a paid API them would make the suite cost money and flake.
 */

const fetchDomainRankOverview = vi.fn();
const fetchRankedKeywords = vi.fn();
const fetchRelevantPages = vi.fn();

vi.mock("@/server/lib/dataforseo/client", () => ({
  loadDataforseoSections: () =>
    Promise.resolve({
      fetchDomainRankOverview,
      fetchRankedKeywords,
      fetchRelevantPages,
    }),
}));

const { CollectorCallError } = await import("./collection-log");
const { collectDomainOverview, hostInEntityScope } =
  await import("./live-domain-collector");

const INPUT = {
  domain: "checksig.com",
  locationCode: 2380,
  languageCode: "it",
  keywordLimit: 10,
  pageLimit: 10,
};

const overview = (
  organic: Record<string, unknown> | null,
  costUsd?: unknown,
) => ({
  data: [{ metrics: { organic } }],
  billing: { path: ["labs", "domain_rank_overview"], costUsd },
});

const keywordRow = (url: string, keyword = "custodia bitcoin") => ({
  keyword_data: {
    keyword,
    keyword_info: { search_volume: 720, cpc: 4.2 },
    keyword_properties: { keyword_difficulty: 41 },
  },
  ranked_serp_element: { serp_item: { rank_absolute: 3, url, etv: 210.4 } },
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchRankedKeywords.mockResolvedValue({
    data: { items: [], totalCount: 0 },
    billing: { path: ["labs", "ranked_keywords"], costUsd: 0.003 },
  });
  fetchRelevantPages.mockResolvedValue({
    data: { items: [], totalCount: 0 },
    billing: { path: ["labs", "relevant_pages"], costUsd: 0.004 },
  });
  fetchDomainRankOverview.mockResolvedValue(
    overview({ etv: 900, count: 21, pos_1: 2 }, 0.002),
  );
});

/**
 * COST. The provider's own figure, and the difference between "free" and
 * "we never learned" — which used to be the same value and is not the same
 * fact. Getting this wrong once already produced a snapshot with real metrics,
 * a job marked failed, and no ledger row at all.
 */
describe("provider cost", () => {
  it("reports a numeric cost as reported, in micro-USD", async () => {
    const result = await collectDomainOverview(INPUT);
    expect(result.calls.map((c) => c.cost)).toEqual([
      { micros: 2000, status: "reported" },
      { micros: 3000, status: "reported" },
      { micros: 4000, status: "reported" },
    ]);
  });

  it("distinguishes a provider-reported zero from a missing cost", async () => {
    fetchDomainRankOverview.mockResolvedValue(
      overview({ etv: 900, count: 21, pos_1: 2 }, 0),
    );
    const result = await collectDomainOverview(INPUT);
    expect(result.calls[0]?.cost).toEqual({ micros: 0, status: "zero" });
  });

  it("reports an absent cost as not_reported, never as zero", async () => {
    fetchDomainRankOverview.mockResolvedValue(
      overview({ etv: 900, count: 21, pos_1: 2 }, undefined),
    );
    const result = await collectDomainOverview(INPUT);
    expect(result.calls[0]?.cost).toEqual({
      micros: null,
      status: "not_reported",
    });
  });

  it("treats a non-numeric or negative cost as not_reported", async () => {
    for (const bad of ["0.01", null, NaN, -1]) {
      fetchDomainRankOverview.mockResolvedValue(
        overview({ etv: 900, count: 21, pos_1: 2 }, bad),
      );
      const result = await collectDomainOverview(INPUT);
      expect(result.calls[0]?.cost.status, String(bad)).toBe("not_reported");
      expect(result.calls[0]?.cost.micros, String(bad)).toBeNull();
    }
  });

  it("never lets NaN reach any numeric field", async () => {
    fetchDomainRankOverview.mockResolvedValue(
      overview({ etv: 900, count: 21, pos_1: 2 }, NaN),
    );
    const result = await collectDomainOverview(INPUT);
    for (const call of result.calls) {
      expect(Number.isNaN(call.cost.micros ?? 0)).toBe(false);
    }
    expect(Number.isNaN(result.metrics.organicTrafficEstimate ?? 0)).toBe(
      false,
    );
  });

  it("lets a provider error throw instead of returning an empty dataset", async () => {
    const boom = new Error("DataForSEO HTTP 401");
    fetchDomainRankOverview.mockRejectedValue(boom);
    // It throws, rather than degrading to `{ organicKeywordCount: 0 }` — zero
    // keywords is a measurement and "we could not ask" is not.
    await expect(collectDomainOverview(INPUT)).rejects.toThrow(
      CollectorCallError,
    );
  });

  it("tags the throw with the endpoint, keeping the original error as cause", async () => {
    // The caller's catch covers all three calls, so the endpoint has to be
    // attached here — a failure recorded against the wrong endpoint is worse
    // than one recorded against none.
    const boom = new Error("DataForSEO HTTP 401");
    fetchRankedKeywords.mockRejectedValue(boom);
    const thrown = await collectDomainOverview(INPUT).catch(
      (error: unknown) => error,
    );
    // Narrowed rather than asserted, so the fields below are checked against
    // the real class instead of a cast that would compile whatever it is.
    if (!(thrown instanceof CollectorCallError)) {
      throw new Error("expected a CollectorCallError");
    }
    expect(thrown.endpointPath).toBe(
      "dataforseo_labs/google/ranked_keywords/live",
    );
    expect(thrown.cause).toBe(boom);
  });
});

/**
 * SCOPE. The overview endpoint has no subdomain switch and counts apex+www;
 * the detail endpoints take an explicit flag. Asking them a narrower question
 * than the overview is what produced 21 keywords beside two empty lists.
 */
describe("entity scope", () => {
  it("accepts the apex and its www host, and nothing else", () => {
    expect(hostInEntityScope("checksig.com", "checksig.com", false)).toBe(true);
    expect(hostInEntityScope("www.checksig.com", "checksig.com", false)).toBe(
      true,
    );
    expect(hostInEntityScope("blog.checksig.com", "checksig.com", false)).toBe(
      false,
    );
    expect(
      hostInEntityScope("checksig.com.evil.tld", "checksig.com", false),
    ).toBe(false);
  });

  it("accepts other subdomains only when the entity opted in", () => {
    expect(hostInEntityScope("blog.checksig.com", "checksig.com", true)).toBe(
      true,
    );
  });

  it("asks the provider for subdomains so www is not excluded", async () => {
    await collectDomainOverview(INPUT);
    expect(fetchRankedKeywords).toHaveBeenCalledWith(
      expect.objectContaining({
        includeSubdomains: true,
        locationCode: 2380,
        languageCode: "it",
      }),
    );
  });

  it("keeps www rows and drops an unapproved subdomain", async () => {
    fetchRankedKeywords.mockResolvedValue({
      data: {
        items: [
          keywordRow("https://www.checksig.com/servizi", "custodia"),
          keywordRow("https://checksig.com/", "checksig"),
          keywordRow("https://blog.checksig.com/post", "blog"),
        ],
        totalCount: 3,
      },
      billing: { path: ["labs", "ranked_keywords"], costUsd: 0.003 },
    });
    const result = await collectDomainOverview(INPUT);
    expect(result.keywords.map((k) => k.keyword)).toEqual([
      "custodia",
      "checksig",
    ]);
  });

  it("normalizes a top page on the www host", async () => {
    fetchRelevantPages.mockResolvedValue({
      data: {
        items: [
          {
            page_address: "https://www.checksig.com/servizi",
            metrics: { organic: { etv: 120.6, count: 9 } },
          },
          {
            page_address: "https://blog.checksig.com/x",
            metrics: { organic: { etv: 999, count: 9 } },
          },
        ],
        totalCount: 2,
      },
      billing: { path: ["labs", "relevant_pages"], costUsd: 0.004 },
    });
    const result = await collectDomainOverview(INPUT);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      url: "https://www.checksig.com/servizi",
      estimatedTraffic: 121,
      keywordCount: 9,
    });
  });
});

/**
 * COMPLETENESS. A positive keyword count beside empty detail sections is a gap
 * or a mapping defect. Calling it complete is exactly how the first live run
 * looked successful while storing nothing.
 */
describe("completeness", () => {
  it("classifies a positive count with empty details as partial, with a reason", async () => {
    const result = await collectDomainOverview(INPUT);
    expect(result.completeness).toBe("partial");
    expect(result.partialReason).toContain("21 organic keywords");
  });

  it("classifies a coherent collection as complete", async () => {
    fetchRankedKeywords.mockResolvedValue({
      data: {
        items: [keywordRow("https://www.checksig.com/a")],
        totalCount: 1,
      },
      billing: { path: ["labs", "ranked_keywords"], costUsd: 0.003 },
    });
    const result = await collectDomainOverview(INPUT);
    expect(result.completeness).toBe("complete");
    expect(result.partialReason).toBeNull();
  });

  it("classifies an unknown domain as no_data and stops before the detail calls", async () => {
    fetchDomainRankOverview.mockResolvedValue(overview(null, 0.002));
    const result = await collectDomainOverview(INPUT);
    expect(result.completeness).toBe("no_data");
    expect(result.metrics.organicKeywordCount).toBeNull();
    expect(fetchRankedKeywords).not.toHaveBeenCalled();
    expect(fetchRelevantPages).not.toHaveBeenCalled();
  });
});
