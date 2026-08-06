import * as entities from "./store";
import * as store from "./site-audit-store";
import * as issueStore from "./site-audit-issue-store";
import { nowIso } from "./ids";
import {
  checkPage,
  type AuditIssue,
  type PageFacts,
  type SiteFacts,
} from "./site-audit-checks";
import { checkSiteWide } from "./site-audit-site-checks";
import { diffAudits, type DiffRun } from "./site-audit-diff";
import { HEALTH_MODEL_VERSION, siteHealth } from "./site-audit-health";
import type { RunOutcome } from "./site-audit-shared";

/**
 * Morgana Search Intelligence — closing an audit run.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * `comparison_status` is decided here and only here. `complete` requires the
 * crawl to have ended because it ran out of pages to visit; a page limit, a
 * deadline or an error all produce `partial`, and the diff will not resolve
 * anything from a partial run.
 */

export async function finishRun(
  runId: string,
  stopReason: "completed" | "page_limit" | "time_limit" | "error",
): Promise<RunOutcome> {
  const run = await store.getRun(runId);
  if (!run) return { runId, status: "failed", reason: "run disappeared" };
  const entity = await entities.getEntity(run.entityId);
  const pages = await store.runPages(runId, 1000);

  const comparisonStatus: "complete" | "partial" =
    stopReason === "completed" ? "complete" : "partial";

  const scope = {
    registrableDomain: entity?.normalizedDomain ?? "",
    includeSubdomains: entity?.includeSubdomains ?? false,
  };
  const byUrl = new Map(pages.map((page) => [page.normalizedUrl, page]));
  const linkRows = await store.internalLinkTargets(runId);

  const brokenInternalTargets: SiteFacts["brokenInternalTargets"] = [];
  const redirectedInternalTargets: SiteFacts["redirectedInternalTargets"] = [];
  const linkedTargets = new Set<string>();
  for (const link of linkRows) {
    linkedTargets.add(link.targetUrl);
    const target = byUrl.get(link.targetUrl);
    if (!target) continue;
    if (target.statusCode !== null && target.statusCode >= 400) {
      brokenInternalTargets.push({
        source: link.sourceUrl,
        target: link.targetUrl,
        status: target.statusCode,
      });
    } else if (target.redirectChainLength > 0) {
      redirectedInternalTargets.push({
        source: link.sourceUrl,
        target: link.targetUrl,
      });
    }
  }

  // Orphans are only claimable from a complete crawl: on a partial one, the
  // page that links to them may simply not have been visited yet.
  const orphanPages =
    comparisonStatus === "complete"
      ? pages
          .filter(
            (page) =>
              page.depth > 0 &&
              !linkedTargets.has(page.normalizedUrl) &&
              (page.statusCode ?? 0) < 400,
          )
          .map((page) => page.url)
      : [];

  const sitemapUrlsNotCrawled = pages
    .filter((page) => page.inSitemap && page.fetchError !== null)
    .map((page) => page.url);

  const site: SiteFacts = {
    registrableDomain: scope.registrableDomain,
    includeSubdomains: scope.includeSubdomains,
    sitemapStatus: run.sitemapStatus,
    robotsStatus: run.robotsStatus,
    sitemapUrlsNotCrawled,
    brokenInternalTargets,
    redirectedInternalTargets,
    orphanPages,
  };

  const facts: PageFacts[] = pages.map((page) => ({
    url: page.url,
    normalizedUrl: page.normalizedUrl,
    statusCode: page.statusCode,
    contentType: page.contentType,
    responseTimeMs: page.responseTimeMs,
    depth: page.depth,
    title: page.title,
    metaDescription: page.metaDescription,
    h1s: page.firstH1 ? [page.firstH1] : [],
    robotsDirective: page.robotsDirective,
    canonical: page.canonicalUrl,
    textLength: page.textLength ?? 0,
    contentHash: page.contentHash,
    internalLinkCount: page.internalLinkCount,
    externalLinkCount: page.externalLinkCount,
    imageCount: page.imageCount,
    imagesMissingAlt: page.imagesMissingAlt,
    invalidImageUrls: 0,
    redirectChain: page.redirectChainLength > 0 ? [page.url] : [],
    finalUrl: page.finalUrl,
    inSitemap: page.inSitemap,
    fetchError: page.fetchError,
    blocked: null,
    isHomepage: page.depth === 0,
  }));
  // h1Count survives the round trip even though only the first heading text
  // does, so "multiple H1" stays detectable from the stored row.
  for (const [index, page] of pages.entries()) {
    const entry = facts[index];
    if (entry && page.h1Count > 1) {
      entry.h1s = Array.from({ length: page.h1Count }, (_, position) =>
        position === 0 ? (page.firstH1 ?? "") : `h1-${String(position)}`,
      );
    }
  }

  const issues: AuditIssue[] = [
    ...facts.flatMap((page) => checkPage(page, site)),
    ...checkSiteWide(facts, site),
  ];

  const previous = await store.lastComparableRun(run.entityId, runId);
  const firstSeen = await issueStore.firstSeenMap(
    run.entityId,
    previous?.id ?? null,
  );
  await issueStore.saveIssues(runId, run.entityId, issues, firstSeen);

  const health = siteHealth({
    pagesCrawled: run.pagesCrawled,
    comparisonStatus,
    issues,
  });

  const severityCount = (severity: string) =>
    issues.filter((entry) => entry.severity === severity).length;

  await store.updateRun(runId, {
    status: "completed",
    completedAt: nowIso(),
    comparisonStatus,
    truncated: comparisonStatus === "partial",
    stopReason,
    issuesTotal: issues.length,
    criticalCount: severityCount("critical"),
    highCount: severityCount("high"),
    mediumCount: severityCount("medium"),
    lowCount: severityCount("low"),
    infoCount: severityCount("info"),
    siteHealth: health.score,
    healthModelVersion: HEALTH_MODEL_VERSION,
  });

  if (previous) {
    const previousIssues = await issueStore.runIssues(previous.id, {
      limit: 2000,
    });
    const previousPages = await store.runPages(previous.id, 1000);
    const current: DiffRun = {
      runId,
      comparisonStatus,
      crawledUrls: pages.map((page) => page.normalizedUrl),
      issues: issues.map((entry) => ({
        issueType: entry.issueType,
        pageUrl: entry.pageUrl,
        severity: entry.severity,
      })),
    };
    const before: DiffRun = {
      runId: previous.id,
      comparisonStatus: previous.comparisonStatus,
      crawledUrls: previousPages.map((page) => page.normalizedUrl),
      issues: previousIssues.map((row) => ({
        issueType: row.issueType,
        pageUrl: row.pageUrl,
        severity: row.severity,
      })),
    };
    const diff = diffAudits(current, before);
    if (diff.comparable) {
      await issueStore.saveIssueEvents(
        runId,
        run.entityId,
        previous.id,
        diff.entries,
      );
    }
  }

  return {
    runId,
    status: "completed",
    pagesCrawled: run.pagesCrawled,
    pagesRemaining: 0,
  };
}

/**
 * One scheduler step.
 *
 * Advances at most one in-flight crawl per invocation and starts at most one
 * new one, so the tick's cost is bounded regardless of how many domains are
 * due. CheckSig weekly, high-priority competitors fortnightly, the rest
 * monthly — all from the entity row, none of it hardcoded per domain.
 */
