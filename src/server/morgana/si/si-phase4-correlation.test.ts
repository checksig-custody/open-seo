import { describe, expect, it } from "vitest";
import {
  computeMomentum,
  correlateReputation,
  detectCampaign,
  escalateImpersonation,
  familyOf,
  MIN_CAMPAIGN_SIGNALS,
} from "./correlation";
import type { Signal } from "./correlation";

/** Phase-4 campaign detection, momentum and reputation correlation. */

const NOW = new Date("2026-08-06T12:00:00.000Z");
const ago = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe("campaign detection", () => {
  const signal = (
    type: Signal["type"],
    days: number,
    magnitude: number | null = 1,
  ): Signal => ({
    type,
    magnitude,
    observedAt: ago(days),
    reason: `${type} observed`,
  });

  const detect = (signals: Signal[], competitor = false) =>
    detectCampaign({
      subjectLabel: "CheckSig",
      subjectEntityId: "se_1",
      subjectIsCompetitor: competitor,
      signals,
      now: NOW,
    });

  it("needs three signals, not two", () => {
    expect(MIN_CAMPAIGN_SIGNALS).toBe(3);
    expect(
      detect([signal("mention_surge", 1), signal("new_pages", 2)]),
    ).toBeNull();
    expect(
      detect([
        signal("mention_surge", 1),
        signal("new_pages", 2),
        signal("new_backlinks", 3),
      ]),
    ).not.toBeNull();
  });

  it("refuses three signals that are all the same story", () => {
    // new_pages and new_landing_pages are one content push at two
    // granularities; counting them as independent would manufacture a campaign
    // out of a single event.
    expect(familyOf("new_pages")).toBe(familyOf("new_landing_pages"));
    expect(
      detect([
        signal("new_pages", 1),
        signal("new_landing_pages", 2),
        signal("new_pages", 3),
      ]),
    ).toBeNull();
  });

  it("ignores signals outside the window", () => {
    expect(
      detect([
        signal("mention_surge", 1),
        signal("new_pages", 2),
        signal("new_backlinks", 30),
      ]),
    ).toBeNull();
  });

  it("counts a repeated signal type once", () => {
    const result = detect([
      signal("mention_surge", 1),
      signal("mention_surge", 2),
      signal("mention_surge", 3),
      signal("new_backlinks", 1),
    ]);
    // Two distinct types is below the threshold however many times they repeat.
    expect(result).toBeNull();
  });

  it("calls coordination signals a possible impersonation campaign", () => {
    const result = detect([
      signal("coordinated_anchors", 1),
      signal("new_backlinks", 2),
      signal("mention_surge", 3),
    ]);
    expect(result?.category).toBe("possible_impersonation_campaign");
  });

  it("separates link building from content", () => {
    expect(
      detect([
        signal("new_backlinks", 1),
        signal("new_referring_domains", 2),
        signal("ranking_gains", 3),
      ])?.category,
    ).toBe("link_building_campaign");
    expect(
      detect([
        signal("new_pages", 1),
        signal("new_keywords", 2),
        signal("mention_surge", 3),
      ])?.category,
    ).toBe("content_campaign");
  });

  it("labels a competitor subject as a competitor campaign", () => {
    const result = detect(
      [
        signal("new_pages", 1),
        signal("new_keywords", 2),
        signal("mention_surge", 3),
      ],
      true,
    );
    expect(result?.category).toBe("competitor_campaign");
  });

  it("derives confidence from breadth rather than volume", () => {
    const narrow = detect([
      signal("mention_surge", 1),
      signal("new_pages", 2),
      signal("new_keywords", 3),
    ]);
    const broad = detect([
      signal("mention_surge", 1),
      signal("new_pages", 2),
      signal("new_backlinks", 3),
      signal("coordinated_anchors", 4),
    ]);
    expect(broad?.confidence ?? 0).toBeGreaterThan(narrow?.confidence ?? 0);
  });

  it("keeps an unknown magnitude null", () => {
    const result = detect([
      signal("mention_surge", 1, null),
      signal("new_pages", 2),
      signal("new_backlinks", 3),
    ]);
    expect(
      result?.signals.find((item) => item.type === "mention_surge")?.magnitude,
    ).toBeNull();
  });
});

describe("competitor momentum", () => {
  it("refuses to state a direction from too little data", () => {
    const result = computeMomentum({ mentionTrend: 0.3, sentimentTrend: null });
    expect(result.state).toBe("insufficient_data");
    expect(result.score).toBeNull();
  });

  it("treats an unmeasured component as unknown, not as zero", () => {
    // Averaging a missing value in as 0 would drag every reading toward
    // "stable" and quietly hide an accelerating competitor.
    const withNulls = computeMomentum({
      mentionTrend: 0.4,
      visibilityTrend: 0.4,
      rankGains: 0.4,
      sentimentTrend: null,
    });
    const withZeros = computeMomentum({
      mentionTrend: 0.4,
      visibilityTrend: 0.4,
      rankGains: 0.4,
      sentimentTrend: 0,
    });
    expect(withNulls.score).toBeGreaterThan(withZeros.score ?? 0);
    expect(
      withNulls.components.find((component) =>
        component.name.includes("sentiment"),
      )?.direction,
    ).toBe("unknown");
  });

  it("shows every component, including the ones it could not measure", () => {
    const result = computeMomentum({
      mentionTrend: 0.1,
      visibilityTrend: 0.1,
      rankGains: 0.1,
    });
    expect(result.components).toHaveLength(8);
    expect(
      result.components.every((component) => component.reason !== ""),
    ).toBe(true);
  });

  it("separates accelerating from merely growing", () => {
    const growing = computeMomentum({
      mentionTrend: 0.05,
      visibilityTrend: 0.05,
      rankGains: 0.05,
    });
    const accelerating = computeMomentum({
      mentionTrend: 0.4,
      visibilityTrend: 0.4,
      rankGains: 0.4,
      newKeywords: 0.4,
    });
    expect(growing.state).toBe("growing");
    expect(accelerating.state).toBe("accelerating");
  });

  it("reports decline", () => {
    expect(
      computeMomentum({
        mentionTrend: -0.3,
        visibilityTrend: -0.2,
        rankGains: -0.2,
      }).state,
    ).toBe("declining");
  });
});

describe("reputation correlation", () => {
  const signal = (family: string, weight: number) => ({
    type: `${family}_signal`,
    family,
    reason: `${family} observed`,
    weight,
    observedAt: NOW.toISOString(),
  });

  it("refuses a finding built on one family", () => {
    // A single negative article is content. It becomes an incident when
    // something unrelated agrees with it.
    expect(
      correlateReputation({
        category: "negative_content_rising",
        signals: [signal("content", 40), signal("content", 40)],
      }),
    ).toBeNull();
  });

  it("produces a finding when independent families converge", () => {
    const result = correlateReputation({
      category: "negative_content_rising",
      signals: [signal("content", 30), signal("mentions", 30)],
    });
    expect(result).not.toBeNull();
    expect(result?.independentFamilies).toBe(2);
  });

  it("orders signals so the heaviest is shown first", () => {
    const result = correlateReputation({
      category: "brand_confusion",
      signals: [signal("mentions", 10), signal("search", 40)],
    });
    expect(result?.signals[0]?.weight).toBe(40);
  });

  it("reaches the security channel only on impersonation with real weight", () => {
    const seo = correlateReputation({
      category: "negative_content_rising",
      signals: [signal("content", 40), signal("mentions", 40)],
    });
    expect(seo?.channel).not.toBe("security");

    const impersonation = correlateReputation({
      category: "possible_impersonation",
      signals: [
        signal("identity", 30),
        signal("telegram", 25),
        signal("links", 20),
      ],
    });
    expect(impersonation?.severity).toBe("critical");
    expect(impersonation?.channel).toBe("security");
  });

  it("sends brand-confusion findings to brand protection, not to security", () => {
    const result = correlateReputation({
      category: "brand_confusion",
      signals: [signal("identity", 30), signal("mentions", 30)],
    });
    expect(result?.channel).toBe("brand_protection");
  });

  it("stays silent for a low-severity SEO finding", () => {
    const result = correlateReputation({
      category: "competitor_reputation_event",
      signals: [signal("content", 5), signal("mentions", 5)],
    });
    expect(result?.severity).toBe("low");
    expect(result?.channel).toBe("none");
  });
});

describe("impersonation escalation", () => {
  it("adds only what phase 3 could not see", () => {
    const result = escalateImpersonation({
      baseRiskScore: 55,
      baseFamilies: 1,
      telegramCount: 4,
      mentionCount: 2,
    });
    expect(result.score).toBeGreaterThan(55);
    expect(result.families).toBe(3);
    expect(result.signals.map((signal) => signal.family)).toContain("telegram");
  });

  it("never lowers the phase-3 reading", () => {
    // The backlink evidence has not gone away just because nothing else agrees.
    const result = escalateImpersonation({
      baseRiskScore: 60,
      baseFamilies: 2,
    });
    expect(result.score).toBe(60);
    expect(result.families).toBe(2);
    expect(result.signals).toEqual([]);
  });

  it("treats a missing correlation count as absent, not as zero activity", () => {
    const missing = escalateImpersonation({
      baseRiskScore: 40,
      baseFamilies: 1,
      telegramCount: null,
    });
    expect(missing.signals).toEqual([]);
    expect(missing.score).toBe(40);
  });

  it("caps the score at 100", () => {
    const result = escalateImpersonation({
      baseRiskScore: 95,
      baseFamilies: 2,
      telegramCount: 9,
      socialCount: 9,
      mentionCount: 9,
      rankingPresence: true,
      backlinkActivity: 40,
    });
    expect(result.score).toBe(100);
  });
});
