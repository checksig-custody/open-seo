import * as store from "./site-audit-store";
import * as issueStore from "./site-audit-issue-store";
import { detectRegressions } from "./site-audit-diff";
import { siteHealth } from "./site-audit-health";

/** Issue evidence is stored as JSON text; a malformed blob renders as empty. */
function parseDetails(raw: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Morgana Search Intelligence — Site Audit read projections.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Row shapes become response shapes here, in one place, so the router stays a
 * route table. Every projection preserves nullability: a `siteHealth` of null
 * means the crawl was partial, and turning it into a zero on the way out would
 * undo the whole point of tracking completeness.
 */

export function projectRun(run: store.AuditRunRow) {
  return {
    id: run.id,
    entityId: run.entityId,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    comparisonStatus: run.comparisonStatus,
    pageLimit: run.pageLimit,
    pagesDiscovered: run.pagesDiscovered,
    pagesCrawled: run.pagesCrawled,
    pagesFailed: run.pagesFailed,
    pagesBlocked: run.pagesBlocked,
    issuesTotal: run.issuesTotal,
    criticalCount: run.criticalCount,
    highCount: run.highCount,
    mediumCount: run.mediumCount,
    lowCount: run.lowCount,
    infoCount: run.infoCount,
    siteHealth: run.siteHealth,
    healthModelVersion: run.healthModelVersion,
    truncated: run.truncated,
    stopReason: run.stopReason,
    sitemapStatus: run.sitemapStatus,
    robotsStatus: run.robotsStatus,
    requestsMade: run.requestsMade,
    bytesFetched: run.bytesFetched,
    durationMs: run.durationMs,
    createdAt: run.createdAt,
  };
}

export function projectIssue(issue: issueStore.AuditIssueRow) {
  return {
    id: issue.id,
    runId: issue.runId,
    issueType: issue.issueType,
    category: issue.category,
    severity: issue.severity,
    status: issue.status,
    pageUrl: issue.pageUrl,
    details: parseDetails(issue.details),
    changeState: issue.changeState,
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
    resolvedAt: issue.resolvedAt,
    reviewedBy: issue.reviewedBy,
    reviewNote: issue.reviewNote,
  };
}

export async function overviewFor(entityId: string) {
  const runs = await store.latestRuns(entityId, 12);
  const current = runs[0];
  if (!current) {
    return {
      entityId,
      run: null,
      previous: null,
      health: null,
      history: [],
      topIssues: [],
      worstPages: [],
      regressions: [],
    };
  }
  const previous = runs.find(
    (run) => run.id !== current.id && run.status === "completed",
  );
  const issues = await issueStore.runIssues(current.id, { limit: 1000 });
  const pages = await store.runPages(current.id, 1000);

  const health = siteHealth({
    pagesCrawled: current.pagesCrawled,
    comparisonStatus: current.comparisonStatus,
    issues: issues.map((issue) => ({
      severity: issue.severity,
      pageUrl: issue.pageUrl,
    })),
  });

  const byType = new Map<string, { count: number; severity: string }>();
  for (const issue of issues) {
    const entry = byType.get(issue.issueType) ?? {
      count: 0,
      severity: issue.severity,
    };
    entry.count += 1;
    byType.set(issue.issueType, entry);
  }
  const byPage = new Map<string, number>();
  for (const issue of issues) {
    if (!issue.pageUrl) continue;
    byPage.set(issue.pageUrl, (byPage.get(issue.pageUrl) ?? 0) + 1);
  }

  const indexablePages = pages.filter((page) => page.indexable === true).length;
  const httpErrors = pages.filter(
    (page) => (page.statusCode ?? 0) >= 400,
  ).length;
  const homepage = pages.find((page) => page.depth === 0);

  const regressions = detectRegressions({
    current: {
      comparisonStatus: current.comparisonStatus,
      homepageReachable: homepage ? (homepage.statusCode ?? 0) < 400 : false,
      httpErrorCount: httpErrors,
      indexablePages,
      siteHealth: current.siteHealth,
      noindexOnStrategicPage: pages
        .filter((page) => page.depth <= 1 && page.indexable === false)
        .map((page) => page.url),
      criticalCanonicalIssues: issues
        .filter(
          (issue) =>
            issue.issueType === "canonical_external" ||
            issue.issueType === "canonical_invalid",
        )
        .map((issue) => issue.pageUrl ?? ""),
      sitemapStatus: current.sitemapStatus,
    },
    previous: previous
      ? {
          httpErrorCount: 0,
          indexablePages: 0,
          siteHealth: previous.siteHealth,
          sitemapStatus: previous.sitemapStatus,
        }
      : null,
  });

  return {
    entityId,
    run: projectRun(current),
    previous: previous ? projectRun(previous) : null,
    health,
    history: runs
      .filter((run) => run.status === "completed")
      .map((run) => ({
        runId: run.id,
        completedAt: run.completedAt,
        siteHealth: run.siteHealth,
        issuesTotal: run.issuesTotal,
        criticalCount: run.criticalCount,
        highCount: run.highCount,
        pagesCrawled: run.pagesCrawled,
        comparisonStatus: run.comparisonStatus,
      })),
    topIssues: [...byType.entries()]
      .map(([issueType, value]) => ({ issueType, ...value }))
      .toSorted((a, b) => b.count - a.count)
      .slice(0, 15),
    worstPages: [...byPage.entries()]
      .map(([url, issueCount]) => ({ url, issueCount }))
      .toSorted((a, b) => b.issueCount - a.issueCount)
      .slice(0, 15),
    regressions,
  };
}
