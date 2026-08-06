import type { IssueSeverity } from "./site-audit-checks";

/**
 * Morgana Search Intelligence — audit-over-audit comparison.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * One rule dominates this module: **an issue may only be called `resolved`
 * after a complete crawl that actually visited the page it was on.**
 *
 * Everything else follows from it. A truncated crawl, an exhausted budget, an
 * unreachable domain or a page that fell outside the page limit all mean the
 * same thing — we did not look — and "we did not look" must never render as
 * "it is fixed". A false `resolved` is the single most damaging output this
 * subsystem could produce: it closes a problem nobody fixed, and the next audit
 * reports it as `new`, which reads as a regression that never happened.
 *
 * Pure, so the rule is testable without a crawl.
 */

export type ChangeState =
  | "new"
  | "persistent"
  | "resolved"
  | "worsened"
  | "improved";

export interface DiffIssue {
  issueType: string;
  pageUrl: string | null;
  severity: IssueSeverity;
}

export interface DiffRun {
  runId: string;
  comparisonStatus: "complete" | "partial" | "not_comparable";
  /** Canonical URLs the run actually fetched. The evidence for `resolved`. */
  crawledUrls: readonly string[];
  issues: readonly DiffIssue[];
}

export interface DiffEntry {
  issueType: string;
  pageUrl: string | null;
  severity: IssueSeverity;
  previousSeverity: IssueSeverity | null;
  state: ChangeState;
  reason: string;
}

interface DiffResult {
  comparable: boolean;
  /** Why the comparison was limited or refused. Always stated. */
  reason: string | null;
  entries: DiffEntry[];
  counts: Record<ChangeState, number>;
  /** Issues that disappeared but could NOT be called resolved, and why. */
  unverified: { issueType: string; pageUrl: string | null; reason: string }[];
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function key(issue: DiffIssue): string {
  return `${issue.issueType}|${issue.pageUrl ?? "__site__"}`;
}

function emptyCounts(): Record<ChangeState, number> {
  return { new: 0, persistent: 0, resolved: 0, worsened: 0, improved: 0 };
}

/**
 * Compare two audit runs.
 *
 * `previous` may be null (the first ever audit), in which case nothing is
 * `new` — everything is simply the baseline, and calling a first observation
 * "new" would make the first audit look like a sudden collapse.
 */
export function diffAudits(
  current: DiffRun,
  previous: DiffRun | null,
): DiffResult {
  if (!previous) {
    return {
      comparable: false,
      reason: "no previous audit to compare against",
      entries: [],
      counts: emptyCounts(),
      unverified: [],
    };
  }
  if (previous.comparisonStatus !== "complete") {
    return {
      comparable: false,
      reason:
        "the previous audit was not complete, so nothing can be compared to it",
      entries: [],
      counts: emptyCounts(),
      unverified: [],
    };
  }

  const currentComplete = current.comparisonStatus === "complete";
  const currentByKey = new Map(
    current.issues.map((entry) => [key(entry), entry]),
  );
  const previousByKey = new Map(
    previous.issues.map((entry) => [key(entry), entry]),
  );
  const crawledNow = new Set(current.crawledUrls);

  const entries: DiffEntry[] = [];
  const unverified: DiffResult["unverified"] = [];
  const counts = emptyCounts();

  for (const [entryKey, issue] of currentByKey) {
    const before = previousByKey.get(entryKey);
    if (!before) {
      entries.push({
        issueType: issue.issueType,
        pageUrl: issue.pageUrl,
        severity: issue.severity,
        previousSeverity: null,
        state: "new",
        reason: "not present in the previous audit",
      });
      counts.new += 1;
      continue;
    }
    const now = SEVERITY_ORDER[issue.severity];
    const then = SEVERITY_ORDER[before.severity];
    const state: ChangeState =
      now > then ? "worsened" : now < then ? "improved" : "persistent";
    entries.push({
      issueType: issue.issueType,
      pageUrl: issue.pageUrl,
      severity: issue.severity,
      previousSeverity: before.severity,
      state,
      reason:
        state === "persistent"
          ? "present in both audits at the same severity"
          : `severity moved from ${before.severity} to ${issue.severity}`,
    });
    counts[state] += 1;
  }

  for (const [entryKey, before] of previousByKey) {
    if (currentByKey.has(entryKey)) continue;

    // The three gates. Each one is a case where the issue's absence is our
    // ignorance rather than the site's improvement.
    if (!currentComplete) {
      unverified.push({
        issueType: before.issueType,
        pageUrl: before.pageUrl,
        reason:
          "the current crawl was partial; absence is not evidence of a fix",
      });
      continue;
    }
    // A site-level issue (no page) is verifiable by a complete crawl alone.
    if (before.pageUrl !== null && !crawledNow.has(before.pageUrl)) {
      unverified.push({
        issueType: before.issueType,
        pageUrl: before.pageUrl,
        reason: "the affected page was not visited by this crawl",
      });
      continue;
    }
    entries.push({
      issueType: before.issueType,
      pageUrl: before.pageUrl,
      severity: before.severity,
      previousSeverity: before.severity,
      state: "resolved",
      reason:
        before.pageUrl === null
          ? "absent from a complete crawl"
          : "the page was crawled again and the issue is gone",
    });
    counts.resolved += 1;
  }

  return {
    comparable: true,
    reason: currentComplete
      ? null
      : "the current crawl was partial: new and persistent issues are reported, resolutions are not",
    entries,
    counts,
    unverified,
  };
}

/**
 * Alert-worthy regressions between two audits.
 *
 * Deliberately short. The channel exists for things somebody must look at
 * today; a missing title is not one of them and belongs in the digest. Every
 * entry here is a page disappearing from search or a site becoming unreachable.
 */
interface RegressionAlert {
  type:
    | "homepage_unreachable"
    | "http_error_surge"
    | "strategic_noindex"
    | "critical_canonical"
    | "indexable_pages_drop"
    | "site_health_drop"
    | "sitemap_unavailable_repeatedly";
  severity: "warning" | "critical";
  reason: string;
  details: Record<string, unknown>;
}

interface RegressionInput {
  current: {
    comparisonStatus: "complete" | "partial" | "not_comparable";
    homepageReachable: boolean;
    httpErrorCount: number;
    indexablePages: number;
    siteHealth: number | null;
    noindexOnStrategicPage: string[];
    criticalCanonicalIssues: string[];
    sitemapStatus: "ok" | "missing" | "invalid" | "not_checked";
  };
  previous: {
    httpErrorCount: number;
    indexablePages: number;
    siteHealth: number | null;
    sitemapStatus: "ok" | "missing" | "invalid" | "not_checked";
  } | null;
}

const HEALTH_DROP_THRESHOLD = 10;
const INDEXABLE_DROP_RATIO = 0.2;
const ERROR_SURGE_RATIO = 2;
const ERROR_SURGE_MINIMUM = 5;

export function detectRegressions(input: RegressionInput): RegressionAlert[] {
  const alerts: RegressionAlert[] = [];
  const { current, previous } = input;

  if (!current.homepageReachable) {
    alerts.push({
      type: "homepage_unreachable",
      severity: "critical",
      reason: "the homepage did not respond during this audit",
      details: {},
    });
  }
  for (const url of current.noindexOnStrategicPage.slice(0, 10)) {
    alerts.push({
      type: "strategic_noindex",
      severity: "critical",
      reason: "a strategic page carries a noindex directive",
      details: { url },
    });
  }
  for (const url of current.criticalCanonicalIssues.slice(0, 10)) {
    alerts.push({
      type: "critical_canonical",
      severity: "warning",
      reason: "a canonical points outside the site or is invalid",
      details: { url },
    });
  }

  if (!previous) return alerts;

  if (
    current.httpErrorCount >= ERROR_SURGE_MINIMUM &&
    current.httpErrorCount >= previous.httpErrorCount * ERROR_SURGE_RATIO
  ) {
    alerts.push({
      type: "http_error_surge",
      severity: "warning",
      reason: "HTTP errors more than doubled since the previous audit",
      details: {
        before: previous.httpErrorCount,
        after: current.httpErrorCount,
      },
    });
  }

  // Only from a complete crawl: a partial one always has "fewer" indexable
  // pages, and alerting on that would fire on every truncated run.
  if (current.comparisonStatus === "complete" && previous.indexablePages > 0) {
    const lost = previous.indexablePages - current.indexablePages;
    if (lost / previous.indexablePages >= INDEXABLE_DROP_RATIO) {
      alerts.push({
        type: "indexable_pages_drop",
        severity: "critical",
        reason: "a significant share of indexable pages disappeared",
        details: {
          before: previous.indexablePages,
          after: current.indexablePages,
          lost,
        },
      });
    }
  }

  if (current.siteHealth !== null && previous.siteHealth !== null) {
    const drop = previous.siteHealth - current.siteHealth;
    if (drop >= HEALTH_DROP_THRESHOLD) {
      alerts.push({
        type: "site_health_drop",
        severity: "warning",
        reason: `Site Health fell by ${drop.toFixed(1)} points`,
        details: { before: previous.siteHealth, after: current.siteHealth },
      });
    }
  }

  // Two audits in a row, not one: a sitemap can be missing for an afternoon.
  if (
    current.sitemapStatus !== "ok" &&
    current.sitemapStatus !== "not_checked" &&
    previous.sitemapStatus !== "ok" &&
    previous.sitemapStatus !== "not_checked"
  ) {
    alerts.push({
      type: "sitemap_unavailable_repeatedly",
      severity: "warning",
      reason: "the sitemap has been unavailable for two consecutive audits",
      details: { status: current.sitemapStatus },
    });
  }

  return alerts;
}
