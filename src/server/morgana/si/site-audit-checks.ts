import { canonicalizeUrl } from "./crawl-frontier";
import { hostInScope } from "./safe-fetch";

/**
 * Morgana Search Intelligence — Site Audit issue classification.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Pure: crawled facts in, issues out. No database, no fetch, no config lookup,
 * so every rule below is directly testable and the classification cannot vary
 * with the environment it runs in.
 *
 * The rules that shaped it:
 *
 * - **An issue carries its evidence.** `details` holds what was observed, and
 *   the UI renders it. A severity on its own is a verdict nobody can check.
 * - **Severity describes consequence, not effort.** A `noindex` on a strategic
 *   page is critical because the page disappears from search; a missing alt is
 *   low because one image loses accessibility text. Sorting by how annoying
 *   something is to fix would make the queue useless.
 * - **Nothing here decides anything.** These are observations for an analyst,
 *   which is why every issue is reviewable and none triggers an action.
 */

export type IssueSeverity = "critical" | "high" | "medium" | "low" | "info";
export type IssueCategory =
  | "crawl"
  | "indexing"
  | "metadata"
  | "links"
  | "images"
  | "content";

export interface AuditIssue {
  issueType: string;
  category: IssueCategory;
  severity: IssueSeverity;
  pageUrl: string | null;
  details: Record<string, unknown>;
}

/** One crawled page, in the shape the checks need. */
export interface PageFacts {
  url: string;
  normalizedUrl: string;
  statusCode: number | null;
  contentType: string | null;
  responseTimeMs: number | null;
  depth: number;
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  robotsDirective: string | null;
  canonical: string | null;
  textLength: number;
  contentHash: string | null;
  internalLinkCount: number;
  externalLinkCount: number;
  imageCount: number;
  imagesMissingAlt: number;
  invalidImageUrls: number;
  redirectChain: string[];
  finalUrl: string | null;
  inSitemap: boolean;
  fetchError: string | null;
  blocked: string | null;
  isHomepage: boolean;
}

export interface SiteFacts {
  registrableDomain: string;
  includeSubdomains: boolean;
  sitemapStatus: "ok" | "missing" | "invalid" | "not_checked";
  robotsStatus: "ok" | "missing" | "invalid" | "not_checked";
  /** Canonical URLs listed in the sitemap that the crawl never reached. */
  sitemapUrlsNotCrawled: string[];
  /** Internal link targets that produced a 4xx. */
  brokenInternalTargets: { source: string; target: string; status: number }[];
  /** Internal link targets that resolve through a redirect. */
  redirectedInternalTargets: { source: string; target: string }[];
  /** Pages nothing links to, computed from the run's link table. */
  orphanPages: string[];
}

const SLOW_RESPONSE_MS = 3000;
const TITLE_MIN = 15;
const TITLE_MAX = 65;
const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 165;
const MAX_LINKS_PER_PAGE = 300;
const MAX_DEPTH = 5;
const THIN_CONTENT_CHARS = 300;
export function issue(
  issueType: string,
  category: IssueCategory,
  severity: IssueSeverity,
  pageUrl: string | null,
  details: Record<string, unknown>,
): AuditIssue {
  return { issueType, category, severity, pageUrl, details };
}

/**
 * Does a robots directive keep the page out of the index?
 *
 * `none` is checked as well as `noindex` — it is the shorthand for
 * "noindex, nofollow" and a check that only looks for the long form misses it.
 */
export function isNoindex(directive: string | null): boolean {
  if (!directive) return false;
  const value = directive.toLowerCase();
  return value.includes("noindex") || /(^|[\s,])none([\s,]|$)/.test(value);
}

/**
 * Transport-level checks.
 *
 * `stop` is set when the page produced no readable body: every later check
 * would then be reading OUR failure to fetch as a defect of the page, which is
 * a different claim entirely.
 */
function crawlChecks(page: PageFacts): { issues: AuditIssue[]; stop: boolean } {
  const issues: AuditIssue[] = [];
  const url = page.url;

  if (page.blocked) {
    issues.push(
      issue("page_blocked_by_policy", "crawl", "info", url, {
        reason: page.blocked,
        note: "the crawler refused this URL; it was never fetched",
      }),
    );
    return { issues, stop: true };
  }
  if (page.fetchError || page.statusCode === null) {
    issues.push(
      issue(
        "page_unreachable",
        "crawl",
        page.isHomepage ? "critical" : "high",
        url,
        { error: page.fetchError ?? "no response" },
      ),
    );
    return { issues, stop: true };
  }

  const status = page.statusCode;
  if (status >= 500) {
    issues.push(
      issue("http_5xx", "crawl", page.isHomepage ? "critical" : "high", url, {
        statusCode: status,
      }),
    );
  } else if (status >= 400) {
    issues.push(
      issue("http_4xx", "crawl", page.isHomepage ? "critical" : "medium", url, {
        statusCode: status,
      }),
    );
  }

  const hops = page.redirectChain.length;
  if (hops > 0) {
    // A single hop is normal (http→https, /path→/path/). A chain is a real
    // cost: every hop is a round trip and dilutes link signals.
    if (hops >= 3) {
      issues.push(
        issue("redirect_chain_excessive", "crawl", "medium", url, {
          hops,
          chain: page.redirectChain.slice(0, 6),
        }),
      );
    } else if (hops === 2) {
      issues.push(
        issue("redirect_chain", "crawl", "low", url, {
          hops,
          chain: page.redirectChain,
        }),
      );
    }
    const final = page.finalUrl ? canonicalizeUrl(page.finalUrl) : null;
    if (
      final &&
      page.redirectChain.some((hop) => canonicalizeUrl(hop) === final)
    ) {
      issues.push(
        issue("redirect_loop", "crawl", "high", url, {
          chain: page.redirectChain.slice(0, 6),
        }),
      );
    }
  }

  if (page.responseTimeMs !== null && page.responseTimeMs > SLOW_RESPONSE_MS) {
    issues.push(
      issue("slow_response", "crawl", "low", url, {
        responseTimeMs: page.responseTimeMs,
        thresholdMs: SLOW_RESPONSE_MS,
      }),
    );
  }
  if (
    status < 400 &&
    page.contentType &&
    !/^(text\/html|application\/xhtml)/i.test(page.contentType)
  ) {
    issues.push(
      issue("unexpected_content_type", "crawl", "low", url, {
        contentType: page.contentType,
      }),
    );
  }

  // A 4xx/5xx page has no metadata worth judging: it has no content.
  return { issues, stop: status >= 400 };
}

/** Indexing: may a search engine keep this page, and does it agree with us. */
function indexingChecks(page: PageFacts, site: SiteFacts): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const url = page.url;

  if (isNoindex(page.robotsDirective)) {
    issues.push(
      issue("noindex", "indexing", page.isHomepage ? "critical" : "high", url, {
        directive: page.robotsDirective,
      }),
    );
  }
  if (!page.canonical) {
    issues.push(issue("canonical_missing", "indexing", "medium", url, {}));
  } else {
    const canonical = canonicalizeUrl(page.canonical, page.url);
    if (!canonical) {
      issues.push(
        issue("canonical_invalid", "indexing", "high", url, {
          canonical: page.canonical,
        }),
      );
    } else {
      let canonicalHost = "";
      try {
        canonicalHost = new URL(canonical).hostname;
      } catch {
        canonicalHost = "";
      }
      const external =
        canonicalHost !== "" &&
        !hostInScope(
          canonicalHost,
          site.registrableDomain,
          site.includeSubdomains,
        );
      if (external) {
        // Pointing the canonical off-site tells search engines to credit
        // someone else with the page. Rarely intentional, always serious.
        issues.push(
          issue("canonical_external", "indexing", "high", url, {
            canonical,
            host: canonicalHost,
          }),
        );
      } else if (canonical !== page.normalizedUrl) {
        issues.push(
          issue("canonical_differs", "indexing", "low", url, {
            canonical,
            page: page.normalizedUrl,
          }),
        );
      }
    }
  }
  if (
    !page.inSitemap &&
    site.sitemapStatus === "ok" &&
    page.statusCode === 200
  ) {
    issues.push(issue("page_missing_from_sitemap", "indexing", "low", url, {}));
  }
  return issues;
}

/** Metadata: the fields a search result is actually built from. */
function metadataChecks(page: PageFacts): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const url = page.url;

  if (!page.title) {
    issues.push(issue("title_missing", "metadata", "high", url, {}));
  } else if (page.title.length < TITLE_MIN) {
    issues.push(
      issue("title_too_short", "metadata", "low", url, {
        length: page.title.length,
        minimum: TITLE_MIN,
      }),
    );
  } else if (page.title.length > TITLE_MAX) {
    issues.push(
      issue("title_too_long", "metadata", "low", url, {
        length: page.title.length,
        maximum: TITLE_MAX,
      }),
    );
  }
  if (!page.metaDescription) {
    issues.push(
      issue("meta_description_missing", "metadata", "medium", url, {}),
    );
  } else if (page.metaDescription.length < DESCRIPTION_MIN) {
    issues.push(
      issue("meta_description_too_short", "metadata", "low", url, {
        length: page.metaDescription.length,
      }),
    );
  } else if (page.metaDescription.length > DESCRIPTION_MAX) {
    issues.push(
      issue("meta_description_too_long", "metadata", "low", url, {
        length: page.metaDescription.length,
      }),
    );
  }
  if (page.h1s.length === 0) {
    issues.push(issue("h1_missing", "metadata", "medium", url, {}));
  } else if (page.h1s.length > 1) {
    issues.push(
      issue("h1_multiple", "metadata", "low", url, {
        count: page.h1s.length,
        headings: page.h1s.slice(0, 5),
      }),
    );
  }

  return issues;
}

/** Links, images and content: everything below the head. */
function bodyChecks(page: PageFacts): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const url = page.url;

  if (page.internalLinkCount + page.externalLinkCount > MAX_LINKS_PER_PAGE) {
    issues.push(
      issue("too_many_links", "links", "low", url, {
        internal: page.internalLinkCount,
        external: page.externalLinkCount,
        threshold: MAX_LINKS_PER_PAGE,
      }),
    );
  }
  if (page.depth > MAX_DEPTH) {
    issues.push(
      issue("excessive_depth", "links", "low", url, {
        depth: page.depth,
        maximum: MAX_DEPTH,
      }),
    );
  }

  if (page.imagesMissingAlt > 0) {
    issues.push(
      issue("image_alt_missing", "images", "low", url, {
        missing: page.imagesMissingAlt,
        total: page.imageCount,
      }),
    );
  }
  if (page.invalidImageUrls > 0) {
    issues.push(
      issue("image_url_invalid", "images", "low", url, {
        count: page.invalidImageUrls,
      }),
    );
  }

  if (page.textLength === 0) {
    issues.push(
      issue("page_empty", "content", page.isHomepage ? "high" : "medium", url, {
        textLength: 0,
      }),
    );
  } else if (page.textLength < THIN_CONTENT_CHARS) {
    issues.push(
      issue("thin_content", "content", "low", url, {
        textLength: page.textLength,
        threshold: THIN_CONTENT_CHARS,
      }),
    );
  }

  return issues;
}

/**
 * Per-page checks. Everything decidable from one page in isolation.
 *
 * Composed from four category functions rather than one long pass: the combined
 * branch count is genuinely high, and someone asking "why is this page
 * non-indexable" should not have to read past the metadata rules to find out.
 */
export function checkPage(page: PageFacts, site: SiteFacts): AuditIssue[] {
  const crawl = crawlChecks(page);
  if (crawl.stop) return crawl.issues;
  return [
    ...crawl.issues,
    ...indexingChecks(page, site),
    ...metadataChecks(page),
    ...bodyChecks(page),
  ];
}
