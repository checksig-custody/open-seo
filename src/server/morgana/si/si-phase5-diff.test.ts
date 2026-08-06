import { describe, expect, it } from "vitest";
import { diffAudits, detectRegressions, type DiffRun } from "./site-audit-diff";

/**
 * Morgana Search Intelligence — phase 5 audit diff and regression alerts.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * The load-bearing assertion in this file is that a partial crawl never
 * resolves an issue: an audit that did not reach a page has learned nothing
 * about it, and silence is not evidence of a fix. Split out of
 * `si-phase5-audit.test.ts`, which covers classification and health.
 */

const run = (overrides: Partial<DiffRun>): DiffRun => ({
  runId: "r1",
  comparisonStatus: "complete",
  crawledUrls: ["https://checksig.com/a", "https://checksig.com/b"],
  issues: [],
  ...overrides,
});

describe("audit diff", () => {
  it("does not call the first audit a wave of new issues", () => {
    const result = diffAudits(
      run({
        issues: [
          {
            issueType: "title_missing",
            pageUrl: "https://checksig.com/a",
            severity: "high",
          },
        ],
      }),
      null,
    );
    expect(result.comparable).toBe(false);
    expect(result.counts.new).toBe(0);
  });

  it("classifies new, persistent, worsened and improved", () => {
    const before = run({
      runId: "r0",
      issues: [
        {
          issueType: "title_missing",
          pageUrl: "https://checksig.com/a",
          severity: "low",
        },
        {
          issueType: "h1_missing",
          pageUrl: "https://checksig.com/a",
          severity: "high",
        },
        {
          issueType: "noindex",
          pageUrl: "https://checksig.com/b",
          severity: "high",
        },
      ],
    });
    const after = run({
      issues: [
        {
          issueType: "title_missing",
          pageUrl: "https://checksig.com/a",
          severity: "high",
        },
        {
          issueType: "h1_missing",
          pageUrl: "https://checksig.com/a",
          severity: "low",
        },
        {
          issueType: "noindex",
          pageUrl: "https://checksig.com/b",
          severity: "high",
        },
        {
          issueType: "page_empty",
          pageUrl: "https://checksig.com/b",
          severity: "medium",
        },
      ],
    });
    const result = diffAudits(after, before);
    expect(result.counts).toMatchObject({
      new: 1,
      worsened: 1,
      improved: 1,
      persistent: 1,
      resolved: 0,
    });
  });

  it("resolves an issue only when the page was crawled again", () => {
    const before = run({
      runId: "r0",
      issues: [
        {
          issueType: "title_missing",
          pageUrl: "https://checksig.com/a",
          severity: "high",
        },
      ],
    });
    const after = run({ issues: [] });
    const result = diffAudits(after, before);
    expect(result.counts.resolved).toBe(1);
    expect(result.unverified).toEqual([]);
  });

  it("REFUSES to resolve anything from a partial crawl", () => {
    const before = run({
      runId: "r0",
      issues: [
        {
          issueType: "title_missing",
          pageUrl: "https://checksig.com/a",
          severity: "high",
        },
      ],
    });
    const after = run({ comparisonStatus: "partial", issues: [] });
    const result = diffAudits(after, before);
    expect(result.counts.resolved).toBe(0);
    expect(result.unverified).toHaveLength(1);
    expect(result.unverified[0]?.reason).toContain("partial");
    expect(result.reason).toContain("resolutions are not");
  });

  it("REFUSES to resolve an issue on a page this crawl never visited", () => {
    const before = run({
      runId: "r0",
      issues: [
        {
          issueType: "title_missing",
          pageUrl: "https://checksig.com/never",
          severity: "high",
        },
      ],
    });
    // Complete crawl, but the affected page was not among the URLs it reached.
    const after = run({ issues: [] });
    const result = diffAudits(after, before);
    expect(result.counts.resolved).toBe(0);
    expect(result.unverified[0]?.reason).toContain("not visited");
  });

  it("refuses to compare against a previous run that was itself partial", () => {
    const before = run({ runId: "r0", comparisonStatus: "partial" });
    const result = diffAudits(run({}), before);
    expect(result.comparable).toBe(false);
    expect(result.entries).toEqual([]);
  });
});

describe("audit regressions", () => {
  const base = {
    comparisonStatus: "complete" as const,
    homepageReachable: true,
    httpErrorCount: 1,
    indexablePages: 100,
    siteHealth: 90,
    noindexOnStrategicPage: [],
    criticalCanonicalIssues: [],
    sitemapStatus: "ok" as const,
  };

  it("alerts on an unreachable homepage and a strategic noindex", () => {
    const alerts = detectRegressions({
      current: {
        ...base,
        homepageReachable: false,
        noindexOnStrategicPage: ["https://checksig.com/"],
      },
      previous: null,
    });
    expect(alerts.map((alert) => alert.type)).toEqual([
      "homepage_unreachable",
      "strategic_noindex",
    ]);
  });

  it("alerts on a real drop in indexable pages but not on a partial crawl", () => {
    const previous = {
      httpErrorCount: 1,
      indexablePages: 100,
      siteHealth: 90,
      sitemapStatus: "ok" as const,
    };
    const real = detectRegressions({
      current: { ...base, indexablePages: 50 },
      previous,
    });
    expect(real.map((alert) => alert.type)).toContain("indexable_pages_drop");

    const partial = detectRegressions({
      current: { ...base, comparisonStatus: "partial", indexablePages: 50 },
      previous,
    });
    expect(partial.map((alert) => alert.type)).not.toContain(
      "indexable_pages_drop",
    );
  });

  it("does not alert on one missing sitemap, only on two in a row", () => {
    const once = detectRegressions({
      current: { ...base, sitemapStatus: "missing" },
      previous: {
        httpErrorCount: 1,
        indexablePages: 100,
        siteHealth: 90,
        sitemapStatus: "ok",
      },
    });
    expect(once.map((alert) => alert.type)).not.toContain(
      "sitemap_unavailable_repeatedly",
    );
    const twice = detectRegressions({
      current: { ...base, sitemapStatus: "missing" },
      previous: {
        httpErrorCount: 1,
        indexablePages: 100,
        siteHealth: 90,
        sitemapStatus: "missing",
      },
    });
    expect(twice.map((alert) => alert.type)).toContain(
      "sitemap_unavailable_repeatedly",
    );
  });
});
