import { describe, expect, it } from "vitest";
import { checkSiteWide } from "./site-audit-site-checks";
import {
  checkPage,
  isNoindex,
  type PageFacts,
  type SiteFacts,
} from "./site-audit-checks";
import { HEALTH_MODEL_VERSION, siteHealth } from "./site-audit-health";

/**
 * Morgana Search Intelligence — phase 5 page, site and health classification.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Ordinary classification cover: what each check fires on, and that the health
 * score refuses to exist for a crawl that did not finish. The diff and
 * regression rules live in `si-phase5-diff.test.ts`, the AI Visibility metrics
 * in `si-phase5-ai.test.ts`.
 */

const site: SiteFacts = {
  registrableDomain: "checksig.com",
  includeSubdomains: false,
  sitemapStatus: "ok",
  robotsStatus: "ok",
  sitemapUrlsNotCrawled: [],
  brokenInternalTargets: [],
  redirectedInternalTargets: [],
  orphanPages: [],
};

function page(overrides: Partial<PageFacts> = {}): PageFacts {
  return {
    url: "https://checksig.com/servizi",
    normalizedUrl: "https://checksig.com/servizi",
    statusCode: 200,
    contentType: "text/html",
    responseTimeMs: 200,
    depth: 1,
    title: "Servizi di custodia bitcoin per istituzionali",
    metaDescription:
      "CheckSig offre custodia istituzionale di bitcoin con segregazione degli asset e proof of reserves verificato.",
    h1s: ["Servizi"],
    robotsDirective: null,
    canonical: "https://checksig.com/servizi",
    textLength: 2500,
    contentHash: "abc123",
    internalLinkCount: 20,
    externalLinkCount: 3,
    imageCount: 4,
    imagesMissingAlt: 0,
    invalidImageUrls: 0,
    redirectChain: [],
    finalUrl: "https://checksig.com/servizi",
    inSitemap: true,
    fetchError: null,
    blocked: null,
    isHomepage: false,
    ...overrides,
  };
}

const types = (issues: { issueType: string }[]) =>
  issues.map((issue) => issue.issueType);

describe("page checks", () => {
  it("finds nothing wrong with a healthy page", () => {
    expect(checkPage(page(), site)).toEqual([]);
  });

  it("rates a homepage failure higher than an inner page failure", () => {
    const inner = checkPage(page({ statusCode: 500 }), site)[0];
    const home = checkPage(
      page({ statusCode: 500, isHomepage: true }),
      site,
    )[0];
    expect(inner?.severity).toBe("high");
    expect(home?.severity).toBe("critical");
  });

  it("treats noindex as a serious indexing problem and reads `none` too", () => {
    expect(isNoindex("none")).toBe(true);
    expect(isNoindex("noindex,nofollow")).toBe(true);
    expect(isNoindex("index,follow")).toBe(false);
    const issues = checkPage(page({ robotsDirective: "noindex" }), site);
    expect(types(issues)).toContain("noindex");
  });

  it("distinguishes an external canonical from a differing one", () => {
    expect(
      types(checkPage(page({ canonical: "https://altro.example/x" }), site)),
    ).toContain("canonical_external");
    expect(
      types(checkPage(page({ canonical: "https://checksig.com/altro" }), site)),
    ).toContain("canonical_differs");
    expect(types(checkPage(page({ canonical: null }), site))).toContain(
      "canonical_missing",
    );
  });

  it("reports metadata problems", () => {
    const issues = types(
      checkPage(
        page({ title: null, metaDescription: null, h1s: ["a", "b"] }),
        site,
      ),
    );
    expect(issues).toContain("title_missing");
    expect(issues).toContain("meta_description_missing");
    expect(issues).toContain("h1_multiple");
  });

  it("reports an empty page and a slow one", () => {
    expect(types(checkPage(page({ textLength: 0 }), site))).toContain(
      "page_empty",
    );
    expect(types(checkPage(page({ responseTimeMs: 9000 }), site))).toContain(
      "slow_response",
    );
  });

  it("records a blocked URL as information, not as a defect of the site", () => {
    const issues = checkPage(page({ blocked: "robots_denied" }), site);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("info");
    expect(issues[0]?.issueType).toBe("page_blocked_by_policy");
  });

  it("carries the evidence with every issue", () => {
    const issue = checkPage(page({ statusCode: 404 }), site)[0];
    expect(issue?.details).toMatchObject({ statusCode: 404 });
  });
});

describe("site checks", () => {
  it("reports duplicate titles across pages", () => {
    const issues = checkSiteWide(
      [
        page({
          url: "https://checksig.com/a",
          normalizedUrl: "https://checksig.com/a",
        }),
        page({
          url: "https://checksig.com/b",
          normalizedUrl: "https://checksig.com/b",
        }),
      ],
      site,
    );
    expect(types(issues)).toContain("title_duplicate");
    expect(types(issues)).toContain("near_duplicate_content");
    expect(types(issues)).toContain("identical_content_different_url");
  });

  it("does not call every empty page a duplicate of every other", () => {
    const issues = checkSiteWide(
      [
        page({
          url: "https://checksig.com/a",
          contentHash: "empty",
          textLength: 0,
        }),
        page({
          url: "https://checksig.com/b",
          contentHash: "empty",
          textLength: 0,
        }),
      ],
      site,
    );
    expect(types(issues)).not.toContain("near_duplicate_content");
  });

  it("reports broken internal links and a missing sitemap", () => {
    const issues = checkSiteWide([page()], {
      ...site,
      sitemapStatus: "missing",
      brokenInternalTargets: [
        {
          source: "https://checksig.com/a",
          target: "https://checksig.com/dead",
          status: 404,
        },
      ],
    });
    expect(types(issues)).toContain("internal_link_broken");
    expect(types(issues)).toContain("sitemap_missing");
  });
});

describe("site health", () => {
  it("refuses to score a partial crawl", () => {
    const result = siteHealth({
      pagesCrawled: 40,
      comparisonStatus: "partial",
      issues: [{ severity: "critical", pageUrl: "https://checksig.com/a" }],
    });
    expect(result.score).toBeNull();
    expect(result.reason).toContain("partial");
    expect(result.modelVersion).toBe(HEALTH_MODEL_VERSION);
  });

  it("shows its arithmetic", () => {
    const result = siteHealth({
      pagesCrawled: 10,
      comparisonStatus: "complete",
      issues: [
        { severity: "critical", pageUrl: "https://checksig.com/a" },
        { severity: "low", pageUrl: "https://checksig.com/b" },
        { severity: "low", pageUrl: "https://checksig.com/c" },
      ],
    });
    expect(result.score).not.toBeNull();
    expect(result.components).toHaveLength(2);
    const critical = result.components.find((c) => c.severity === "critical");
    expect(critical).toMatchObject({
      weight: 25,
      issueCount: 1,
      affectedPages: 1,
    });
    // 100 - (25 * 1/10) - (1 * 2/10) = 97.3
    expect(result.score).toBeCloseTo(97.3, 1);
  });

  it("scales the penalty with the share of pages affected", () => {
    const small = siteHealth({
      pagesCrawled: 5,
      comparisonStatus: "complete",
      issues: Array.from({ length: 5 }, (_, i) => ({
        severity: "high" as const,
        pageUrl: `https://checksig.com/${String(i)}`,
      })),
    });
    const large = siteHealth({
      pagesCrawled: 500,
      comparisonStatus: "complete",
      issues: Array.from({ length: 5 }, (_, i) => ({
        severity: "high" as const,
        pageUrl: `https://checksig.com/${String(i)}`,
      })),
    });
    expect((small.score ?? 0) < (large.score ?? 0)).toBe(true);
  });
});
