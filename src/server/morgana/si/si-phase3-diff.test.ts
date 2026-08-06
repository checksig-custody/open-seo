import { describe, expect, it } from "vitest";
import { classifyRisk, routeRisk, scoreBacklinkRisk } from "./backlink-risk";
import {
  assessSnapshot,
  buildBacklinkGap,
  classifyBacklinkGap,
  confirmLosses,
  diffSnapshots,
} from "./backlink-diff";

/** Phase-3 snapshot comparison, risk scoring, alert routing and backlink gap. */

const BRAND = ["checksig"] as const;

describe("snapshot quality", () => {
  it("refuses to compare when there is no baseline", () => {
    expect(
      assessSnapshot({
        providerOk: true,
        collected: 10,
        limit: 500,
        noBaseline: true,
      }).status,
    ).toBe("not_comparable");
  });

  it("refuses to compare a failed provider call", () => {
    expect(
      assessSnapshot({ providerOk: false, collected: 0, limit: 500 }).status,
    ).toBe("not_comparable");
  });

  it("marks a capped collection partial", () => {
    const result = assessSnapshot({
      providerOk: true,
      collected: 500,
      limit: 500,
    });
    expect(result.status).toBe("partial");
    expect(result.reason).toContain("capped");
  });

  it("marks a budget-truncated collection partial even below the cap", () => {
    expect(
      assessSnapshot({
        providerOk: true,
        collected: 12,
        limit: 500,
        budgetTruncated: true,
      }).status,
    ).toBe("partial");
  });

  it("marks it partial when the provider says there is more", () => {
    expect(
      assessSnapshot({
        providerOk: true,
        collected: 100,
        limit: 500,
        reportedTotal: 900,
      }).status,
    ).toBe("partial");
  });

  it("is complete only when nothing suggests truncation", () => {
    expect(
      assessSnapshot({
        providerOk: true,
        collected: 100,
        limit: 500,
        reportedTotal: 100,
      }).status,
    ).toBe("complete");
  });
});

describe("new and lost detection", () => {
  const previous = [
    { key: "a", domain: "a.com" },
    { key: "b", domain: "b.com" },
  ];
  const current = [
    { key: "b", domain: "b.com" },
    { key: "c", domain: "c.com" },
  ];

  it("reports both sides on a complete snapshot", () => {
    const result = diffSnapshots(previous, current, {
      status: "complete",
      reason: null,
    });
    expect(result.added.map((item) => item.key)).toEqual(["c"]);
    expect(result.removed.map((item) => item.key)).toEqual(["a"]);
  });

  it("never derives a loss from a partial snapshot", () => {
    // This is the whole point: a capped page looks exactly like a removal.
    const result = diffSnapshots(previous, current, {
      status: "partial",
      reason: "collection capped at 500 rows",
    });
    expect(result.removed).toEqual([]);
    expect(result.added.map((item) => item.key)).toEqual(["c"]);
    expect(result.lossSuppressionReason).toContain("capped");
  });

  it("reports nothing at all when the snapshot is not comparable", () => {
    const result = diffSnapshots(previous, current, {
      status: "not_comparable",
      reason: "provider request failed",
    });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("requires two consecutive absences before confirming a loss", () => {
    const candidates = [{ key: "a", domain: "a.com" }];
    expect(confirmLosses(candidates, new Set()).confirmed).toEqual([]);
    expect(confirmLosses(candidates, new Set()).pending).toHaveLength(1);
    expect(confirmLosses(candidates, new Set(["a"])).confirmed).toHaveLength(1);
  });
});

describe("risk scoring", () => {
  const base = {
    normalizedDomain: "checksig-support.tk",
    domainRoot: "checksig-support.tk",
    tld: "tk",
    brandTokens: BRAND,
    officialRoots: ["checksig.com"],
  };

  it("never flags our own domain, whatever else it looks like", () => {
    const result = scoreBacklinkRisk({
      ...base,
      normalizedDomain: "checksig.com",
      domainRoot: "checksig.com",
    });
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it("explains every point it assigns", () => {
    const result = scoreBacklinkRisk(base);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThan(0);
    for (const reason of result.reasons) {
      expect(reason.reason).not.toBe("");
      expect(reason.evidence).not.toBe("");
      expect(reason.weight).toBeGreaterThan(0);
    }
    expect(
      result.reasons.reduce((total, reason) => total + reason.weight, 0),
    ).toBe(result.score);
  });

  it("orders reasons so the heaviest is shown first", () => {
    const weights = scoreBacklinkRisk(base).reasons.map(
      (reason) => reason.weight,
    );
    expect(weights.toSorted((a, b) => b - a)).toEqual(weights);
  });

  it("cannot reach high_risk on a single component", () => {
    // The band starts at 75 and the heaviest component is 30, by design.
    const single = scoreBacklinkRisk({
      normalizedDomain: "chekcsig.com",
      domainRoot: "chekcsig.com",
      tld: "com",
      brandTokens: BRAND,
    });
    expect(single.classification).not.toBe("high_risk");
  });

  it("treats an unknown spam score as unknown, not as clean", () => {
    const unknown = scoreBacklinkRisk({ ...base, spamScore: null });
    const clean = scoreBacklinkRisk({ ...base, spamScore: 0 });
    expect(unknown.score).toBe(clean.score);
    expect(
      unknown.reasons.some((reason) => reason.component === "high_spam_score"),
    ).toBe(false);
  });

  it("maps scores onto the documented bands", () => {
    expect(classifyRisk(0)).toBe("low");
    expect(classifyRisk(24)).toBe("low");
    expect(classifyRisk(25)).toBe("review");
    expect(classifyRisk(49)).toBe("review");
    expect(classifyRisk(50)).toBe("suspicious");
    expect(classifyRisk(74)).toBe("suspicious");
    expect(classifyRisk(75)).toBe("high_risk");
    expect(classifyRisk(100)).toBe("high_risk");
  });

  it("counts one observation once, however many components see it", () => {
    // brand_in_domain and lookalike_domain are the same fact; if they counted
    // as two families a single hostname could unlock the security channel.
    const result = scoreBacklinkRisk({
      normalizedDomain: "checksig-login.com",
      domainRoot: "checksig-login.com",
      tld: "com",
      brandTokens: BRAND,
    });
    expect(result.independentSignals).toBe(1);
  });

  it("raises the score when Morgana already knows the domain", () => {
    const without = scoreBacklinkRisk(base);
    const with_ = scoreBacklinkRisk({
      ...base,
      brandProtection: { telegramMentionCount: 3, mentionCount: 2 },
    });
    expect(with_.score).toBeGreaterThan(without.score);
    expect(
      with_.reasons.some(
        (reason) => reason.component === "telegram_or_social_signal",
      ),
    ).toBe(true);
  });
});

describe("alert routing", () => {
  it("reaches the security channel only on high risk with two independent signals", () => {
    const result = scoreBacklinkRisk({
      normalizedDomain: "checksig-wallet.tk",
      domainRoot: "checksig-wallet.tk",
      tld: "tk",
      brandTokens: BRAND,
      anchors: ["checksig login"],
      anchorSignals: ["brand anchor combined with login"],
      brandProtection: { telegramMentionCount: 4 },
      spamScore: 80,
    });
    expect(result.classification).toBe("high_risk");
    expect(result.independentSignals).toBeGreaterThanOrEqual(2);
    expect(routeRisk(result)).toBe("security");
  });

  it("keeps ordinary SEO findings out of the security channel", () => {
    const review = scoreBacklinkRisk({
      normalizedDomain: "smallblog.xyz",
      domainRoot: "smallblog.xyz",
      tld: "xyz",
      brandTokens: BRAND,
      domainRank: 5,
    });
    expect(routeRisk(review)).not.toBe("security");
  });

  it("sends nothing at all for a clean domain", () => {
    const clean = scoreBacklinkRisk({
      normalizedDomain: "coindesk.com",
      domainRoot: "coindesk.com",
      tld: "com",
      brandTokens: BRAND,
      domainRank: 90,
    });
    expect(routeRisk(clean)).toBe("none");
  });
});

describe("backlink gap", () => {
  it("classifies the five categories", () => {
    expect(
      classifyBacklinkGap({
        normalizedDomain: "a.com",
        domain: "a.com",
        linksPrimary: true,
        competitorEntityIds: ["c1"],
      }).category,
    ).toBe("shared");
    expect(
      classifyBacklinkGap({
        normalizedDomain: "b.com",
        domain: "b.com",
        linksPrimary: true,
        competitorEntityIds: [],
      }).category,
    ).toBe("primary_only");
    expect(
      classifyBacklinkGap({
        normalizedDomain: "c.com",
        domain: "c.com",
        linksPrimary: false,
        competitorEntityIds: ["c1"],
        domainRank: 5,
      }).category,
    ).toBe("competitor_only");
    expect(
      classifyBacklinkGap({
        normalizedDomain: "d.com",
        domain: "d.com",
        linksPrimary: false,
        competitorEntityIds: ["c1", "c2"],
        domainRank: 5,
      }).category,
    ).toBe("multi_competitor_only");
    expect(
      classifyBacklinkGap({
        normalizedDomain: "e.com",
        domain: "e.com",
        linksPrimary: false,
        competitorEntityIds: ["c1", "c2"],
        domainRank: 70,
        spamScore: 2,
      }).category,
    ).toBe("new_opportunity");
  });

  it("never presents a spammy or risky domain as an opportunity", () => {
    const spammy = classifyBacklinkGap({
      normalizedDomain: "farm.tk",
      domain: "farm.tk",
      linksPrimary: false,
      competitorEntityIds: ["c1", "c2"],
      domainRank: 80,
      spamScore: 90,
    });
    expect(spammy.category).not.toBe("new_opportunity");

    const risky = classifyBacklinkGap({
      normalizedDomain: "checksig-bonus.com",
      domain: "checksig-bonus.com",
      linksPrimary: false,
      competitorEntityIds: ["c1", "c2"],
      domainRank: 80,
      spamScore: 1,
      riskClassification: "suspicious",
    });
    expect(risky.category).not.toBe("new_opportunity");
  });

  it("leaves the opportunity score null when quality is unknown", () => {
    const result = classifyBacklinkGap({
      normalizedDomain: "unknown.com",
      domain: "unknown.com",
      linksPrimary: false,
      competitorEntityIds: ["c1"],
      domainRank: null,
    });
    expect(result.opportunityScore).toBeNull();
  });

  it("matches domains across their different written forms", () => {
    const gap = buildBacklinkGap({
      primaryDomains: [
        {
          normalizedDomain: "shared.com",
          domain: "shared.com",
          domainRank: 50,
        },
      ],
      competitorDomains: [
        {
          entityId: "c1",
          domains: [
            {
              normalizedDomain: "shared.com",
              domain: "www.Shared.com",
              domainRank: 50,
            },
          ],
        },
      ],
    });
    expect(gap).toHaveLength(1);
    expect(gap[0]?.category).toBe("shared");
  });

  it("does not let a null quality signal erase a known one", () => {
    const gap = buildBacklinkGap({
      primaryDomains: [],
      competitorDomains: [
        {
          entityId: "c1",
          domains: [
            {
              normalizedDomain: "x.com",
              domain: "x.com",
              domainRank: 60,
              spamScore: 3,
            },
          ],
        },
        {
          entityId: "c2",
          domains: [
            {
              normalizedDomain: "x.com",
              domain: "x.com",
              domainRank: null,
              spamScore: null,
            },
          ],
        },
      ],
    });
    expect(gap[0]?.domainRank).toBe(60);
    expect(gap[0]?.category).toBe("new_opportunity");
  });
});
