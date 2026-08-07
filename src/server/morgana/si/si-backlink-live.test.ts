import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — the live backlink collector.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P13).
 *
 * Two failure modes shape every case here, and both are ways of turning an
 * absence into a claim:
 *
 *   a provider error read as an empty profile — every backlink "lost";
 *   a truncated SAMPLE read as the whole profile — everything outside the
 *   first 100 rows "lost".
 *
 * The collector exists to make both impossible to express.
 */

const fetchBacklinksSummary = vi.fn();
const fetchBacklinksRows = vi.fn();
const fetchReferringDomains = vi.fn();

vi.mock("@/server/lib/dataforseo/client", () => ({
  loadDataforseoSections: () =>
    Promise.resolve({
      fetchBacklinksSummary,
      fetchBacklinksRows,
      fetchReferringDomains,
    }),
}));

const { collectLiveBacklinks, DEFAULT_SAMPLE_LIMIT } =
  await import("./backlink-live-collector");
const { createLiveBacklinkProvider, DEFAULT_LIMITS, mergeLimits } =
  await import("./backlink-provider");

/** A billing block that states no cost at all. */
const noBilling = (path: string[]) => ({ path });

const billing = (costUsd: number, path: string[]) => ({ path, costUsd });

const summaryBilling = billing(0.02, ["v3", "backlinks", "summary", "live"]);
const domainsBilling = billing(0.011, [
  "v3",
  "backlinks",
  "referring_domains",
  "live",
]);
const rowsBilling = billing(0.011, ["v3", "backlinks", "backlinks", "live"]);

const summary = (over: Record<string, unknown> = {}) => ({
  data: {
    target: "checksig.com",
    rank: 210,
    backlinks: 1240,
    referring_domains: 96,
    referring_main_domains: 88,
    referring_pages: 1100,
    referring_ips: 74,
    referring_subnets: 61,
    broken_backlinks: 3,
    new_backlinks: 12,
    lost_backlinks: 4,
    backlinks_spam_score: 8,
    referring_links_attributes: { nofollow: 240, anchor: 900, image: 100 },
    ...over,
  },
  billing: summaryBilling,
});

const backlinkRow = (over: Record<string, unknown> = {}) => ({
  domain_from: "example.it",
  url_from: "https://example.it/articolo",
  url_to: "https://www.checksig.com/it/",
  anchor: "custodia bitcoin",
  item_type: "anchor",
  dofollow: true,
  domain_from_rank: 120,
  page_from_rank: 40,
  backlink_spam_score: 2,
  first_seen: "2026-01-02 10:00:00 +00:00",
  last_seen: "2026-08-01 10:00:00 +00:00",
  ...over,
});

const domainRow = (over: Record<string, unknown> = {}) => ({
  domain: "example.it",
  backlinks: 12,
  dofollow: 10,
  nofollow: 2,
  rank: 120,
  backlinks_spam_score: 2,
  first_seen: "2026-01-02 10:00:00 +00:00",
  country: "IT",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchBacklinksSummary.mockResolvedValue(summary());
  fetchReferringDomains.mockResolvedValue({
    data: { items: [domainRow()], totalCount: 96 },
    billing: domainsBilling,
  });
  fetchBacklinksRows.mockResolvedValue({
    data: { items: [backlinkRow()], totalCount: 1240 },
    billing: rowsBilling,
  });
});

describe("the profile", () => {
  it("keeps every metric the provider stated", async () => {
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.profile.backlinkCount).toBe(1240);
    expect(outcome.profile.referringDomainCount).toBe(96);
    expect(outcome.profile.referringIps).toBe(74);
    expect(outcome.profile.brokenBacklinks).toBe(3);
    // Derived only from stated parts: 1240 attributes total minus 240 nofollow.
    expect(outcome.profile.nofollowCount).toBe(240);
    expect(outcome.profile.dofollowCount).toBe(1000);
  });

  it("keeps a stated zero as zero and an unstated metric as null", async () => {
    fetchBacklinksSummary.mockResolvedValue(
      summary({ broken_backlinks: 0, referring_ips: null }),
    );
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    expect(outcome.profile.brokenBacklinks).toBe(0);
    expect(outcome.profile.referringIps).toBeNull();
  });

  it("refuses to invent a follow split from an absent nofollow figure", async () => {
    fetchBacklinksSummary.mockResolvedValue(
      summary({ referring_links_attributes: { anchor: 900 } }),
    );
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    expect(outcome.profile.dofollowCount).toBeNull();
    expect(outcome.profile.nofollowCount).toBeNull();
  });

  it("survives a malformed summary without producing NaN", async () => {
    fetchBacklinksSummary.mockResolvedValue({
      data: { backlinks: "lots", referring_domains: Number.NaN },
      billing: summaryBilling,
    });
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    expect(outcome.profile.backlinkCount).toBeNull();
    expect(outcome.profile.referringDomainCount).toBeNull();
    expect(Number.isNaN(outcome.accounting.actualCostMicros)).toBe(false);
  });
});

describe("the sample", () => {
  it("states the limit and the coverage rather than implying completeness", async () => {
    const outcome = await collectLiveBacklinks({
      target: "checksig.com",
      sampleLimit: 1,
    });
    if (outcome.status !== "completed") throw new Error("expected completion");
    expect(outcome.sampleLimit).toBe(1);
    // One row returned against a limit of one: the list is a ceiling, so the
    // profile is larger than what was examined.
    expect(outcome.snapshotStatus).toBe("partial");
    expect(outcome.reportedTotals.backlinks).toBe(1240);
  });

  it("reports no_data for a healthy response that holds nothing", async () => {
    fetchBacklinksSummary.mockResolvedValue(
      summary({ backlinks: 0, referring_domains: 0 }),
    );
    fetchReferringDomains.mockResolvedValue({
      data: { items: [], totalCount: 0 },
      billing: domainsBilling,
    });
    fetchBacklinksRows.mockResolvedValue({
      data: { items: [], totalCount: 0 },
      billing: rowsBilling,
    });
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    // A real answer — the provider knows the domain and holds nothing — and a
    // different fact from an error.
    expect(outcome.snapshotStatus).toBe("no_data");
    expect(outcome.backlinks).toHaveLength(0);
  });
});

describe("rows", () => {
  it("canonicalizes source and target, and keeps them distinct", async () => {
    fetchBacklinksRows.mockResolvedValue({
      data: {
        items: [
          backlinkRow({
            url_from: "HTTPS://Example.IT:443/articolo/",
            url_to: "https://www.checksig.com/it/",
          }),
        ],
        totalCount: 1,
      },
      billing: rowsBilling,
    });
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    const row = outcome.backlinks[0];
    expect(row.sourceDomain).toBe("example.it");
    expect(row.targetDomain).toContain("checksig.com");
    // Two URLs on one domain are two backlinks, not one.
    expect(row.sourceUrl).not.toBe(row.targetUrl);
  });

  it("keeps an empty anchor empty instead of inventing one", async () => {
    fetchBacklinksRows.mockResolvedValue({
      data: { items: [backlinkRow({ anchor: "" })], totalCount: 1 },
      billing: rowsBilling,
    });
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    expect(outcome.backlinks[0].anchorText).toBe("");
  });

  it("drops a row with no origin rather than fabricating one", async () => {
    fetchBacklinksRows.mockResolvedValue({
      data: {
        items: [backlinkRow({ url_from: null, domain_from: null })],
        totalCount: 1,
      },
      billing: rowsBilling,
    });
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    expect(outcome.backlinks).toHaveLength(0);
  });

  it("deduplicates referring domains by their canonical form", async () => {
    fetchReferringDomains.mockResolvedValue({
      data: {
        items: [domainRow(), domainRow({ domain: "WWW.Example.IT" })],
        totalCount: 2,
      },
      billing: domainsBilling,
    });
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    const domains = new Set(outcome.referringDomains.map((d) => d.domain));
    expect(domains.size).toBe(1);
  });
});

describe("accounting", () => {
  it("sums the three calls and reports the provider's own cost", async () => {
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    // 0.02 + 0.011 + 0.011 USD, in integer micro-USD.
    expect(outcome.accounting.actualCostMicros).toBe(42_000);
    expect(outcome.accounting.costStatus).toBe("reported");
    expect(outcome.accounting.requests).toBe(3);
    expect(outcome.endpoints).toHaveLength(3);
  });

  it("charges the money that IS known when one call states no cost", async () => {
    fetchBacklinksSummary.mockResolvedValue({
      data: summary().data,
      billing: { path: ["v3", "backlinks", "summary", "live"] },
    });
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    // Mixed reporting rolls up as `reported`: the two costs that ARE known are
    // real money and must be charged. The unreported one is visible in the
    // request counts rather than being invented as a zero.
    expect(outcome.accounting.costStatus).toBe("reported");
    expect(outcome.accounting.actualCostMicros).toBe(22_000);
    expect(outcome.accounting.requests).toBe(3);
  });

  it("reports not_reported only when no call stated a cost at all", async () => {
    fetchBacklinksSummary.mockResolvedValue({
      data: summary().data,
      billing: noBilling(["v3", "backlinks", "summary", "live"]),
    });
    fetchReferringDomains.mockResolvedValue({
      data: { items: [domainRow()], totalCount: 96 },
      billing: noBilling(["v3", "backlinks", "referring_domains", "live"]),
    });
    fetchBacklinksRows.mockResolvedValue({
      data: { items: [backlinkRow()], totalCount: 1240 },
      billing: noBilling(["v3", "backlinks", "backlinks", "live"]),
    });
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    if (outcome.status !== "completed") throw new Error("expected completion");
    // An absence, not a measurement of zero.
    expect(outcome.accounting.costStatus).toBe("not_reported");
    expect(outcome.accounting.actualCostMicros).toBe(0);
  });

  it("keeps the cost of calls that succeeded before a later one failed", async () => {
    fetchBacklinksRows.mockRejectedValue(new Error("500 upstream unavailable"));
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    // Summary and referring domains were charged and stay in the ledger; the
    // failing call is counted with its cost not reported.
    expect(outcome.accounting.requests).toBe(3);
    expect(outcome.accounting.actualCostMicros).toBe(31_000);
    expect(outcome.failure.code).toBe(
      "DATAFORSEO_BACKLINKS_UPSTREAM_UNAVAILABLE",
    );
  });
});

describe("failures", () => {
  const cases: [string, string][] = [
    ["401 unauthorized", "DATAFORSEO_BACKLINKS_AUTH_FAILED"],
    ["403 forbidden: not enabled", "DATAFORSEO_BACKLINKS_NOT_ENABLED"],
    ["429 rate limit exceeded", "DATAFORSEO_BACKLINKS_RATE_LIMITED"],
    ["invalid response shape", "DATAFORSEO_BACKLINKS_INVALID_RESPONSE"],
    ["something else entirely", "DATAFORSEO_BACKLINKS_OPERATION_FAILED"],
  ];

  it.each(cases)("classifies %s", async (message, code) => {
    fetchBacklinksSummary.mockRejectedValue(new Error(message));
    const outcome = await collectLiveBacklinks({ target: "checksig.com" });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.failure.code).toBe(code);
    // The provider's own words never survive into what is stored.
    expect(outcome.failure.message).not.toContain(message);
  });

  it("never lets a failure look like an empty profile", async () => {
    fetchBacklinksSummary.mockRejectedValue(new Error("401 unauthorized"));
    const provider = createLiveBacklinkProvider();
    const result = await provider.collect({
      target: "checksig.com",
      limits: DEFAULT_LIMITS,
    });
    // This is the property that stops a failed call from reporting every
    // backlink as lost.
    expect(result.providerOk).toBe(false);
    expect(result.profile.backlinkCount).toBeNull();
    expect(result.backlinks).toHaveLength(0);
    expect(result.snapshotStatus).toBe("no_data");
  });
});

describe("the provider adapter", () => {
  it("bounds the sample and reports coverage against the stated total", async () => {
    const provider = createLiveBacklinkProvider();
    const result = await provider.collect({
      target: "checksig.com",
      limits: DEFAULT_LIMITS,
    });
    expect(result.providerOk).toBe(true);
    expect(result.source).toBe("dataforseo");
    expect(result.sampleLimit).toBe(DEFAULT_SAMPLE_LIMIT);
    expect(result.reportedBacklinkTotal).toBe(1240);
    // One sampled row of 1240 reported.
    expect(result.datasetCoverage).toBeCloseTo(1 / 1240, 6);
    expect(result.datasetSignature).toContain("subdomains=on");
  });

  it("leaves coverage null when the provider states no total to divide by", async () => {
    fetchBacklinksSummary.mockResolvedValue(summary({ backlinks: null }));
    fetchBacklinksRows.mockResolvedValue({
      data: { items: [backlinkRow()], totalCount: null },
      billing: rowsBilling,
    });
    const provider = createLiveBacklinkProvider();
    const result = await provider.collect({
      target: "checksig.com",
      limits: DEFAULT_LIMITS,
    });
    expect(result.datasetCoverage).toBeNull();
  });

  /**
   * THE DEFECT THIS SECTION EXISTS FOR, found in production on 2026-08-07.
   *
   * The HTTP route builds `{backlinks: num(body.backlink_limit) ?? undefined,
   * …}` and the service spread it over the defaults. A spread does not skip an
   * explicit `undefined` — it assigns it — so a request with no limits (the
   * normal case) erased all three defaults and `Math.min(undefined, …)` became
   * NaN. The Conio snapshot landed with a null `sample_limit` and the signature
   * `live|NaN|subdomains=on|status=live|internal=excluded`, which compares
   * unequal to CheckSig's and would have made the two profiles incomparable.
   *
   * Every existing test above passes a COMPLETE `DEFAULT_LIMITS`, which is
   * exactly why none of them caught it.
   */
  it("keeps the defaults when the caller specifies no limits at all", async () => {
    const provider = createLiveBacklinkProvider();
    const result = await provider.collect({
      target: "checksig.com",
      // Precisely what the route sends for an empty request body.
      limits: mergeLimits({
        backlinks: undefined,
        referringDomains: undefined,
        anchors: undefined,
      }),
    });
    expect(result.sampleLimit).toBe(DEFAULT_SAMPLE_LIMIT);
    expect(result.datasetSignature).toBe(
      "live|100|subdomains=on|status=live|internal=excluded",
    );
  });

  it("never writes a signature containing NaN", async () => {
    const provider = createLiveBacklinkProvider();
    for (const limits of [
      mergeLimits(undefined),
      mergeLimits({ backlinks: Number.NaN }),
      mergeLimits({ backlinks: 0, referringDomains: -5 }),
    ]) {
      const result = await provider.collect({
        target: "checksig.com",
        limits,
      });
      expect(Number.isFinite(result.sampleLimit)).toBe(true);
      expect(result.datasetSignature).not.toContain("NaN");
    }
  });
});

describe("merging caller limits", () => {
  it("ignores an absent override rather than assigning it", () => {
    expect(mergeLimits({ backlinks: undefined })).toEqual(DEFAULT_LIMITS);
    expect(mergeLimits(undefined)).toEqual(DEFAULT_LIMITS);
  });

  it("accepts a real override", () => {
    expect(mergeLimits({ backlinks: 50 }).backlinks).toBe(50);
  });

  it("rejects values that are not a usable count", () => {
    // Zero, negative and NaN are not "collect nothing" — they are a caller
    // that failed to state a limit, and the default is the honest reading.
    expect(mergeLimits({ backlinks: 0 }).backlinks).toBe(
      DEFAULT_LIMITS.backlinks,
    );
    expect(mergeLimits({ backlinks: -1 }).backlinks).toBe(
      DEFAULT_LIMITS.backlinks,
    );
    expect(mergeLimits({ backlinks: Number.NaN }).backlinks).toBe(
      DEFAULT_LIMITS.backlinks,
    );
  });
});

describe("the cost ceiling", () => {
  it("is at least what a collection was actually observed to cost", async () => {
    const { WORST_CASE_BACKLINK_MICROS } =
      await import("./backlink-live-collector");
    // The first live collection of checksig.com cost 79 236 µUSD against a
    // 25 000 µUSD ceiling, because Backlinks charges per returned row on top of
    // a per-request base. A ceiling below the only measurement we have is not a
    // ceiling, and this test is what stops it drifting back down.
    expect(WORST_CASE_BACKLINK_MICROS).toBeGreaterThanOrEqual(79_236);
    // And it must stay inside the authorised verification budget, so the guard
    // denies rather than the plan being quietly exceeded.
    expect(WORST_CASE_BACKLINK_MICROS).toBeLessThanOrEqual(100_000);
  });

  it("moves with the sample limit, since cost scales with rows", async () => {
    // `DEFAULT_SAMPLE_LIMIT` is already bound at module scope; re-importing it
    // here shadowed that binding and invited the two copies to disagree.
    const { WORST_CASE_BACKLINK_MICROS } =
      await import("./backlink-live-collector");
    // 100 rows per list bought 79 236 µUSD. Anyone raising the sample without
    // raising the ceiling reintroduces the 2026-08-06 overrun exactly.
    const observedPerRowBudget =
      WORST_CASE_BACKLINK_MICROS / DEFAULT_SAMPLE_LIMIT;
    expect(observedPerRowBudget).toBeGreaterThanOrEqual(792);
  });
});
