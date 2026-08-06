import { describe, expect, it } from "vitest";
import {
  citationDelta,
  computeMetrics,
  detectAiEvents,
  normalizeDomain,
  type SnapshotFacts,
} from "./ai-visibility";

/**
 * Morgana Search Intelligence — AI Visibility metrics and events.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * The distinctions under test are the ones the product rests on: mention is
 * not citation, an unobserved value is not zero, and only a critical query
 * earns an interruption.
 */

/** Module scope so every case starts from the same observation. */
function snapshotOf(overrides: Partial<SnapshotFacts> = {}): SnapshotFacts {
  return {
    queryId: "q1",
    priority: "normal",
    aiResultPresent: true,
    primaryBrandMentioned: true,
    primaryBrandCited: false,
    competitorMentions: 1,
    competitorCitations: 1,
    citedDomainCount: 3,
    checkedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("ai visibility metrics", () => {
  it("keeps mention and citation apart", () => {
    const metrics = computeMetrics(
      [snapshotOf(), snapshotOf({ queryId: "q2", primaryBrandCited: true })],
      [],
      2,
    );
    expect(metrics.queriesWithBrandMention).toBe(2);
    expect(metrics.queriesWithBrandCitation).toBe(1);
  });

  it("returns nulls rather than zeros when nothing was observed", () => {
    const metrics = computeMetrics([], [], 7);
    expect(metrics.queriesWithAiResult).toBeNull();
    expect(metrics.citationShare).toBeNull();
    expect(metrics.citationShareStatus).toBe("not_observed");
    expect(metrics.queriesObserved).toBe(0);
  });

  it("refuses a citation share below the coverage floor", () => {
    const metrics = computeMetrics(
      [snapshotOf()],
      [
        {
          queryId: "q1",
          normalizedDomain: "checksig.com",
          entityId: "e1",
          citationOrder: 0,
        },
        {
          queryId: "q1",
          normalizedDomain: "altro.example",
          entityId: null,
          citationOrder: 1,
        },
      ],
      // Ten queries tracked, one observed: 10% coverage.
      10,
    );
    expect(metrics.citationShare).toBeNull();
    expect(metrics.citationShareStatus).toBe("insufficient_coverage");
  });

  it("computes a citation share once coverage is sufficient", () => {
    const metrics = computeMetrics(
      [snapshotOf(), snapshotOf({ queryId: "q2" })],
      [
        {
          queryId: "q1",
          normalizedDomain: "checksig.com",
          entityId: "e1",
          citationOrder: 0,
        },
        {
          queryId: "q1",
          normalizedDomain: "altro.example",
          entityId: null,
          citationOrder: 1,
        },
        {
          queryId: "q2",
          normalizedDomain: "altro.example",
          entityId: null,
          citationOrder: 0,
        },
      ],
      2,
    );
    expect(metrics.citationShare).toBeCloseTo(1 / 3, 5);
    expect(metrics.topCitedDomains[0]?.domain).toBe("altro.example");
  });

  it("normalizes a domain to its join key", () => {
    expect(normalizeDomain("https://WWW.CheckSig.com/path?x=1")).toBe(
      "checksig.com",
    );
  });
});

describe("ai visibility events", () => {
  const delta = citationDelta(
    [
      {
        queryId: "q1",
        normalizedDomain: "checksig-support.tk",
        entityId: null,
        citationOrder: 0,
      },
    ],
    [
      {
        queryId: "q1",
        normalizedDomain: "checksig.com",
        entityId: "e1",
        citationOrder: 0,
      },
    ],
  );

  it("routes a flagged domain being cited to brand protection", () => {
    const events = detectAiEvents({
      queryId: "q1",
      priority: "critical",
      current: null,
      previous: null,
      delta,
      suspiciousDomains: new Set(["checksig-support.tk"]),
      citationShareChange: null,
    });
    const suspicious = events.find(
      (event) => event.eventType === "suspicious_domain_cited",
    );
    expect(suspicious?.channel).toBe("brand_protection");
    expect(suspicious?.severity).toBe("critical");
  });

  it("only raises a lost citation on a critical query", () => {
    const critical = detectAiEvents({
      queryId: "q1",
      priority: "critical",
      current: null,
      previous: null,
      delta,
      suspiciousDomains: new Set(),
      citationShareChange: null,
    });
    expect(
      critical.find((event) => event.eventType === "citation_lost")?.channel,
    ).toBe("intel");

    const normal = detectAiEvents({
      queryId: "q1",
      priority: "normal",
      current: null,
      previous: null,
      delta,
      suspiciousDomains: new Set(),
      citationShareChange: null,
    });
    // Recorded, but routed nowhere: not every fact deserves a message.
    expect(
      normal.find((event) => event.eventType === "citation_lost")?.channel,
    ).toBe("none");
  });

  it("raises a citation-share move only past the threshold", () => {
    const small = detectAiEvents({
      queryId: "q1",
      priority: "normal",
      current: null,
      previous: null,
      delta: { gained: [], lost: [] },
      suspiciousDomains: new Set(),
      citationShareChange: 0.05,
    });
    expect(small).toEqual([]);
    const large = detectAiEvents({
      queryId: "q1",
      priority: "normal",
      current: null,
      previous: null,
      delta: { gained: [], lost: [] },
      suspiciousDomains: new Set(),
      citationShareChange: -0.3,
    });
    expect(large[0]?.eventType).toBe("citation_share_change");
    expect(large[0]?.severity).toBe("warning");
  });
});
