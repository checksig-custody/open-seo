import { describe, expect, it } from "vitest";
import {
  classifyKeyword,
  frequencyHoursFor,
  isValidKeyword,
  normalizeKeyword,
  priorityWeight,
  SEED_KEYWORDS,
} from "./keywords";
import {
  classifyGap,
  computeShareOfSearch,
  ctrFor,
  CTR_MODEL_VERSION,
  opportunityScore,
  type Observation,
} from "./gap";
import { detectRankingEvents, detectShareShift } from "./events";

/** Morgana Search Intelligence — phase 2 core tests (patch P7). */

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

describe("keyword normalisation", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeKeyword("  Custodia   BITCOIN ")).toBe("custodia bitcoin");
  });

  // Folding accents would merge two queries that rank differently in Italian.
  it("preserves accents", () => {
    expect(normalizeKeyword("Eredità Bitcoin")).toBe("eredità bitcoin");
  });

  it("strips surrounding punctuation but keeps internal characters", () => {
    expect(normalizeKeyword('"check-sig"!')).toBe("check-sig");
  });

  it("rejects empty and over-long keywords", () => {
    expect(isValidKeyword(" ")).toBe(false);
    expect(isValidKeyword("a")).toBe(false);
    expect(isValidKeyword("x".repeat(201))).toBe(false);
    expect(isValidKeyword("custodia bitcoin")).toBe(true);
  });
});

describe("clustering", () => {
  it("puts brand terms in the brand cluster", () => {
    expect(classifyKeyword("CheckSig recensioni")?.slug).toBe("brand-checksig");
  });

  // Order matters: a brand term inside a generic phrase stays brand.
  it("prefers the brand cluster over the generic one", () => {
    expect(classifyKeyword("custodia bitcoin checksig")?.slug).toBe(
      "brand-checksig",
    );
  });

  it("recognises competitor brands", () => {
    expect(classifyKeyword("conio commissioni")?.slug).toBe("competitor-brand");
  });

  it("returns null rather than a catch-all bucket", () => {
    // An unclustered keyword is a visible configuration gap, not something to
    // silently give a default weight to.
    expect(classifyKeyword("previsioni meteo domani")).toBeNull();
  });

  it("assigns every seed keyword to a cluster", () => {
    const unclustered = SEED_KEYWORDS.filter(
      (k) => classifyKeyword(k.keyword) === null,
    );
    expect(unclustered).toEqual([]);
  });
});

describe("priority", () => {
  it("maps priority to the documented cadences", () => {
    expect(frequencyHoursFor("critical")).toBe(24);
    expect(frequencyHoursFor("high")).toBe(56);
    expect(frequencyHoursFor("normal")).toBe(168);
    expect(frequencyHoursFor("low")).toBe(336);
  });

  it("weights critical keywords above low ones", () => {
    expect(priorityWeight("critical")).toBeGreaterThan(priorityWeight("low"));
  });
});

describe("keyword gap classification", () => {
  const primary = "checksig";

  it("reports strong when we lead every competitor", () => {
    const r = classifyGap({
      primaryEntityId: primary,
      current: [found(primary, 2), found("conio", 5)],
    });
    expect(r.category).toBe("strong");
    expect(r.bestCompetitorRank).toBe(5);
  });

  it("reports weak when we are far behind the best competitor", () => {
    const r = classifyGap({
      primaryEntityId: primary,
      current: [found(primary, 22), found("conio", 4)],
    });
    expect(r.category).toBe("weak");
  });

  it("reports shared when close behind", () => {
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [found(primary, 7), found("conio", 4)],
      }).category,
    ).toBe("shared");
  });

  it("distinguishes primary_only, competitor_only and missing", () => {
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [found(primary, 5), absent("conio")],
      }).category,
    ).toBe("primary_only");
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [absent(primary), found("conio", 5)],
      }).category,
    ).toBe("competitor_only");
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [absent(primary), absent("conio")],
      }).category,
    ).toBe("missing");
  });

  it("reports new and lost against the previous observation", () => {
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [found(primary, 8)],
        previous: [absent(primary)],
      }).category,
    ).toBe("new");
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [absent(primary)],
        previous: [found(primary, 8)],
      }).category,
    ).toBe("lost");
  });

  it("reports improved and declined past the movement threshold", () => {
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [found(primary, 5)],
        previous: [found(primary, 20)],
      }).category,
    ).toBe("improved");
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [found(primary, 25)],
        previous: [found(primary, 5)],
      }).category,
    ).toBe("declined");
  });

  it("ignores movement below the threshold", () => {
    expect(
      classifyGap({
        primaryEntityId: primary,
        current: [found(primary, 6)],
        previous: [found(primary, 8)],
      }).category,
    ).not.toBe("improved");
  });

  // Absence must never become a number.
  it("never substitutes a sentinel position for not ranking", () => {
    const r = classifyGap({
      primaryEntityId: primary,
      current: [absent(primary), found("conio", 3)],
    });
    expect(r.primaryRank).toBeNull();
  });
});

describe("opportunity score", () => {
  it("is null when volume is unknown, not zero", () => {
    expect(opportunityScore(null, 20, 3)).toBeNull();
  });

  it("is zero when we already lead", () => {
    expect(opportunityScore(1000, 2, 5)).toBe(0);
  });

  it("scales with volume and gap", () => {
    expect(opportunityScore(1000, 20, 10)).toBe(10_000);
    expect(opportunityScore(2000, 20, 10)).toBe(20_000);
  });

  it("treats not ranking as the full addressable gap", () => {
    expect(opportunityScore(100, null, 5)).toBe(9500);
  });
});

describe("CTR model", () => {
  it("is monotonically non-increasing across the head", () => {
    for (let i = 1; i < 10; i += 1) {
      expect(ctrFor(i)).toBeGreaterThanOrEqual(ctrFor(i + 1));
    }
  });

  it("gives nothing to a domain that does not rank", () => {
    expect(ctrFor(null)).toBe(0);
  });

  it("gives a small non-zero value in the tail and nothing past it", () => {
    expect(ctrFor(15)).toBeGreaterThan(0);
    expect(ctrFor(50)).toBe(0);
  });

  it("is versioned so a curve change is visible in history", () => {
    expect(CTR_MODEL_VERSION).toMatch(/^ctr-/);
  });
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
    expect(r.keywordsConsidered).toBe(1);
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

describe("ranking event detection", () => {
  const base = {
    trackedKeywordId: "kw1",
    primaryEntityId: "checksig",
    snapshotDate: "2026-08-06",
  };

  it("emits nothing without a previous observation", () => {
    expect(
      detectRankingEvents({
        ...base,
        priority: "normal",
        current: [found("checksig", 3)],
      }),
    ).toEqual([]);
  });

  it("announces a top-3 entry immediately", () => {
    const events = detectRankingEvents({
      ...base,
      priority: "normal",
      current: [found("checksig", 2)],
      previous: [found("checksig", 8)],
    });
    expect(events.map((e) => e.eventType)).toContain("entered_top_3");
  });

  it("does not report both top-3 and top-10 for one move", () => {
    const types = detectRankingEvents({
      ...base,
      priority: "normal",
      current: [found("checksig", 2)],
      previous: [found("checksig", 30)],
    }).map((e) => e.eventType);
    expect(types).toContain("entered_top_3");
    expect(types).not.toContain("entered_top_10");
  });

  // The noise-suppression rule: one bad reading is not an alert.
  it("does not announce a loss on a single observation", () => {
    const events = detectRankingEvents({
      ...base,
      priority: "normal",
      current: [absent("checksig")],
      previous: [found("checksig", 5)],
      // No beforePrevious: the loss is unconfirmed.
    });
    expect(events).toEqual([]);
  });

  it("announces a loss once it is confirmed by the prior observation", () => {
    const events = detectRankingEvents({
      ...base,
      priority: "normal",
      current: [absent("checksig")],
      previous: [found("checksig", 5)],
      beforePrevious: [found("checksig", 4)],
    });
    expect(events.map((e) => e.eventType)).toContain("left_top_10");
  });

  it("escalates a confirmed loss on a critical keyword", () => {
    const events = detectRankingEvents({
      ...base,
      priority: "critical",
      current: [absent("checksig")],
      previous: [found("checksig", 5)],
      beforePrevious: [found("checksig", 4)],
    });
    expect(events.map((e) => e.eventType)).toContain("critical_keyword_lost");
  });

  it("announces a large gain immediately", () => {
    expect(
      detectRankingEvents({
        ...base,
        priority: "normal",
        current: [found("checksig", 4)],
        previous: [found("checksig", 20)],
      }).map((e) => e.eventType),
    ).toContain("gained_10_plus");
  });

  it("reports competitive overtakes only for critical keywords", () => {
    const args = {
      ...base,
      current: [found("checksig", 6), found("conio", 2)],
      previous: [found("checksig", 3), found("conio", 5)],
    };
    expect(
      detectRankingEvents({ ...args, priority: "critical" }).map(
        (e) => e.eventType,
      ),
    ).toContain("overtaken_by_competitor");
    expect(
      detectRankingEvents({ ...args, priority: "normal" }).map(
        (e) => e.eventType,
      ),
    ).not.toContain("overtaken_by_competitor");
  });

  it("produces a stable dedupe key per keyword, entity, type and day", () => {
    const [event] = detectRankingEvents({
      ...base,
      priority: "normal",
      current: [found("checksig", 2)],
      previous: [found("checksig", 8)],
    });
    expect(event?.dedupeKey).toBe("kw1|checksig|entered_top_3|2026-08-06");
  });
});

describe("share of search shift", () => {
  it("ignores small moves", () => {
    expect(
      detectShareShift({
        entityId: "checksig",
        previousShare: 0.4,
        currentShare: 0.42,
        snapshotDate: "2026-08-06",
      }),
    ).toBeNull();
  });

  it("announces a move past three points", () => {
    expect(
      detectShareShift({
        entityId: "checksig",
        previousShare: 0.4,
        currentShare: 0.45,
        snapshotDate: "2026-08-06",
      })?.eventType,
    ).toBe("share_of_search_shift");
  });

  it("stays silent when either side is unknown", () => {
    expect(
      detectShareShift({
        entityId: "checksig",
        previousShare: null,
        currentShare: 0.9,
        snapshotDate: "2026-08-06",
      }),
    ).toBeNull();
  });
});
