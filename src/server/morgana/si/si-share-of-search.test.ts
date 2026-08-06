import { describe, expect, it } from "vitest";
import { computeShareOfSearch, CTR_MODEL_VERSION } from "./gap";

interface Observation {
  entityId: string;
  rankGroup: number | null;
  isFound: boolean;
}

const found = (entityId: string, rankGroup: number): Observation => ({
  entityId,
  rankGroup,
  isFound: true,
});
const absent = (entityId: string): Observation => ({
  entityId,
  rankGroup: null,
  isFound: false,
});
const kw = (
  id: string,
  volume: number | null,
  observations: Observation[],
) => ({
  trackedKeywordId: id,
  searchVolume: volume,
  clusterWeight: 1,
  priorityWeight: 1,
  observations,
});

/**
 * Tracked Keyword Share of Search.
 *
 * Split from `si-phase2.test.ts` for size. Every case is one question: when may
 * this number be computed at all, and when must it refuse — because a share
 * computed from two keywords out of forty is not a smaller truth, it is a
 * different and wrong one.
 */
describe("tracked keyword share of search", () => {
  it("computes shares that sum to one", () => {
    const r = computeShareOfSearch(
      [
        kw("k1", 1000, [found("checksig", 1), found("conio", 5)]),
        kw("k2", 500, [found("checksig", 2), found("conio", 3)]),
      ],
      ["checksig", "conio"],
    );
    expect(r.status).toBe("ok");
    const sum = r.results.reduce((a, x) => a + (x.share ?? 0), 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(r.results[0]?.share).toBeGreaterThan(r.results[1]?.share ?? 0);
  });

  it("refuses when coverage is too thin", () => {
    const r = computeShareOfSearch(
      [
        kw("k1", 1000, [absent("checksig"), absent("conio")]),
        kw("k2", 1000, [absent("checksig"), absent("conio")]),
        kw("k3", 1000, [found("checksig", 4), absent("conio")]),
      ],
      ["checksig", "conio"],
    );
    expect(r.status).toBe("insufficient_data");
    expect(r.results.every((x) => x.share === null)).toBe(true);
  });

  // A long tail of unmeasured keywords must not quietly dominate.
  it("skips keywords with unknown volume rather than assuming one", () => {
    const r = computeShareOfSearch(
      [
        kw("k1", 1000, [found("checksig", 1), found("conio", 8)]),
        kw("k2", null, [absent("checksig"), found("conio", 1)]),
      ],
      ["checksig", "conio"],
    );
    expect(r.status).toBe("ok");
    // "Considered" now means looked at, and "eligible" means able to carry
    // weight — the same words on the success path and the refusal path, which
    // they were not before. The unmeasured keyword is counted as an exclusion
    // with its reason, not silently dropped from the total.
    expect(r.keywordsConsidered).toBe(2);
    expect(r.eligibleKeywords).toBe(1);
    expect(r.exclusions.volumeUnknown).toBe(1);
    expect(r.coverage).toBe(1);
  });

  it("refuses with no keywords or no domains", () => {
    expect(computeShareOfSearch([], ["a", "b"]).status).toBe(
      "insufficient_data",
    );
    expect(
      computeShareOfSearch([kw("k", 10, [found("a", 1)])], []).status,
    ).toBe("insufficient_data");
  });

  it("stamps the CTR model version on the result", () => {
    expect(
      computeShareOfSearch([kw("k", 10, [found("a", 1)])], ["a"])
        .ctrModelVersion,
    ).toBe(CTR_MODEL_VERSION);
  });
});
