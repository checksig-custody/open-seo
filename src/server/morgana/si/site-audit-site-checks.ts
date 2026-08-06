import { hammingDistance } from "./site-audit-parse";
import {
  issue,
  type AuditIssue,
  type IssueCategory,
  type IssueSeverity,
  type PageFacts,
  type SiteFacts,
} from "./site-audit-checks";

/**
 * Morgana Search Intelligence — Site Audit, site-wide checks.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Split from the per-page checks because these are a different kind of claim: a
 * duplicate is a RELATIONSHIP, and a page cannot know it is one. Everything
 * here needs the whole crawl in hand.
 */

/**
 * Out of 32 bits.
 *
 * Measured rather than guessed: a realistic page with one changed sentence sits
 * at 3-4 bits, and two genuinely unrelated pages sit above 12. Five keeps the
 * gap wide on both sides — tight enough that unrelated pages never pair, loose
 * enough that a rotating date does not hide a duplicate.
 */
const NEAR_DUPLICATE_BITS = 5;

/**
 * Site-wide checks: everything that needs more than one page to see.
 *
 * Duplicate detection lives here rather than in `checkPage` for the obvious
 * reason — a duplicate is a relationship, and a page cannot know it is one.
 */
function checkSite(pages: readonly PageFacts[], site: SiteFacts): AuditIssue[] {
  const issues: AuditIssue[] = [];

  if (site.sitemapStatus === "missing") {
    issues.push(issue("sitemap_missing", "indexing", "medium", null, {}));
  } else if (site.sitemapStatus === "invalid") {
    issues.push(issue("sitemap_invalid", "indexing", "medium", null, {}));
  }
  if (site.sitemapUrlsNotCrawled.length > 0) {
    issues.push(
      issue("sitemap_url_unreachable", "indexing", "medium", null, {
        count: site.sitemapUrlsNotCrawled.length,
        examples: site.sitemapUrlsNotCrawled.slice(0, 10),
      }),
    );
  }
  if (site.robotsStatus === "invalid") {
    issues.push(issue("robots_invalid", "indexing", "medium", null, {}));
  }

  for (const broken of site.brokenInternalTargets.slice(0, 200)) {
    issues.push(
      issue("internal_link_broken", "links", "high", broken.source, {
        target: broken.target,
        statusCode: broken.status,
      }),
    );
  }
  for (const redirected of site.redirectedInternalTargets.slice(0, 200)) {
    issues.push(
      issue("internal_link_redirects", "links", "low", redirected.source, {
        target: redirected.target,
      }),
    );
  }
  for (const orphan of site.orphanPages.slice(0, 200)) {
    // "When detectable" matters: a page reached only from the sitemap has no
    // incoming internal link *that this crawl saw*, which is what we claim.
    issues.push(
      issue("orphan_page", "links", "medium", orphan, {
        note: "no internal link to this page was found during this crawl",
      }),
    );
  }
  return issues;
}

/**
 * Duplicate and near-duplicate detection.
 *
 * Separate from the rest of the site-wide checks because it is the only part
 * that compares pages with each other rather than with a rule, and because the
 * combined branch count of one function doing both is past what anyone can
 * hold in their head.
 */
function duplicateChecks(pages: readonly PageFacts[]): AuditIssue[] {
  const issues: AuditIssue[] = [];

  const byTitle = new Map<string, string[]>();
  const byDescription = new Map<string, string[]>();
  const byH1 = new Map<string, string[]>();
  const byHash = new Map<string, string[]>();

  for (const page of pages) {
    if (page.statusCode === null || page.statusCode >= 400) continue;
    if (page.title) {
      byTitle.set(page.title, [...(byTitle.get(page.title) ?? []), page.url]);
    }
    if (page.metaDescription) {
      byDescription.set(page.metaDescription, [
        ...(byDescription.get(page.metaDescription) ?? []),
        page.url,
      ]);
    }
    const h1 = page.h1s[0];
    if (h1) byH1.set(h1, [...(byH1.get(h1) ?? []), page.url]);
    // A fingerprint of empty text is shared by every empty page and says
    // nothing about duplication, so it is excluded rather than reported.
    if (
      page.contentHash &&
      page.contentHash !== "empty" &&
      page.textLength > 0
    ) {
      byHash.set(page.contentHash, [
        ...(byHash.get(page.contentHash) ?? []),
        page.url,
      ]);
    }
  }

  const duplicates = (
    grouped: Map<string, string[]>,
    issueType: string,
    category: IssueCategory,
    severity: IssueSeverity,
  ) => {
    for (const [value, urls] of grouped) {
      if (urls.length < 2) continue;
      for (const url of urls.slice(0, 50)) {
        issues.push(
          issue(issueType, category, severity, url, {
            value: value.slice(0, 200),
            duplicateCount: urls.length,
            others: urls.filter((other) => other !== url).slice(0, 5),
          }),
        );
      }
    }
  };

  duplicates(byTitle, "title_duplicate", "metadata", "medium");
  duplicates(byDescription, "meta_description_duplicate", "metadata", "low");
  duplicates(byH1, "h1_duplicate", "metadata", "low");

  // Near-duplicates are compared by Hamming distance, not by equality: the
  // fingerprint is a SimHash, so "almost the same page" is a small distance
  // rather than an identical string. Pairwise over the fingerprints present,
  // which is bounded by the page limit.
  const fingerprints = [...byHash.entries()];
  const nearDuplicates = new Map<string, Set<string>>();
  for (let i = 0; i < fingerprints.length; i += 1) {
    for (let j = i + 1; j < fingerprints.length; j += 1) {
      const [leftHash, leftUrls] = fingerprints[i] ?? ["", []];
      const [rightHash, rightUrls] = fingerprints[j] ?? ["", []];
      if (hammingDistance(leftHash, rightHash) > NEAR_DUPLICATE_BITS) continue;
      for (const url of leftUrls) {
        nearDuplicates.set(
          url,
          new Set([...(nearDuplicates.get(url) ?? []), ...rightUrls]),
        );
      }
      for (const url of rightUrls) {
        nearDuplicates.set(
          url,
          new Set([...(nearDuplicates.get(url) ?? []), ...leftUrls]),
        );
      }
    }
  }
  // Identical fingerprints are near-duplicates of each other too.
  for (const [, urls] of fingerprints) {
    if (urls.length < 2) continue;
    for (const url of urls) {
      nearDuplicates.set(
        url,
        new Set([
          ...(nearDuplicates.get(url) ?? []),
          ...urls.filter((other) => other !== url),
        ]),
      );
    }
  }
  for (const [url, others] of nearDuplicates) {
    if (others.size === 0) continue;
    issues.push(
      issue("near_duplicate_content", "content", "medium", url, {
        duplicateCount: others.size + 1,
        others: [...others].slice(0, 5),
      }),
    );
  }

  // Same fingerprint AND same length: not "similar", the same page under two
  // URLs, which is a different and more serious problem than near-duplication.
  const byExact = new Map<string, string[]>();
  for (const page of pages) {
    if (!page.contentHash || page.contentHash === "empty") continue;
    if (page.statusCode === null || page.statusCode >= 400) continue;
    const key = `${page.contentHash}:${String(page.textLength)}`;
    byExact.set(key, [...(byExact.get(key) ?? []), page.url]);
  }
  for (const [, urls] of byExact) {
    if (urls.length < 2) continue;
    for (const url of urls.slice(0, 50)) {
      issues.push(
        issue("identical_content_different_url", "content", "medium", url, {
          duplicateCount: urls.length,
          others: urls.filter((other) => other !== url).slice(0, 5),
        }),
      );
    }
  }

  return issues;
}

/** The site-wide surface: structural findings plus duplicate relationships. */
export function checkSiteWide(
  pages: readonly PageFacts[],
  site: SiteFacts,
): AuditIssue[] {
  return [...checkSite(pages, site), ...duplicateChecks(pages)];
}
