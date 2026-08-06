import { badRequest, clamp, envelope, json, num, readJson, str } from "./http";
import * as store from "./site-audit-store";
import * as issueStore from "./site-audit-issue-store";
import * as service from "./site-audit-service";
import { diffAudits, type DiffRun } from "./site-audit-diff";
import { overviewFor, projectIssue, projectRun } from "./p5-projections";
import type { SiRequestContext } from "./router";

/**
 * Morgana Search Intelligence — phase 5 Site Audit routes.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Read surfaces plus three operations: request an audit, advance one, and set
 * an issue's review status. Nothing here accepts a URL — an audit targets a
 * configured entity id, which is what keeps the crawler unable to be pointed
 * at an arbitrary destination.
 */

const ISSUE_STATUSES = ["open", "acknowledged", "ignored", "resolved"] as const;

function isIssueStatus(
  value: unknown,
): value is (typeof ISSUE_STATUSES)[number] {
  return (
    typeof value === "string" &&
    (ISSUE_STATUSES as readonly string[]).includes(value)
  );
}

/** Collapse a stored run and its rows into the shape the diff compares. */
function toDiffRun(
  run: store.AuditRunRow,
  issues: issueStore.AuditIssueRow[],
  pages: store.AuditPageRow[],
): DiffRun {
  return {
    runId: run.id,
    comparisonStatus: run.comparisonStatus,
    crawledUrls: pages.map((page) => page.normalizedUrl),
    issues: issues.map((issue) => ({
      issueType: issue.issueType,
      pageUrl: issue.pageUrl,
      severity: issue.severity,
    })),
  };
}

export async function dispatchSiteAudit(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, url, config, providerStatus } = ctx;
  const method = request.method;

  if (route === "site-audit/cost" && method === "GET") {
    const status = await issueStore.siteAuditCostStatus();
    return json(envelope(config, status, { providerStatus }));
  }

  {
    const match = /^site-audit\/overview\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      return json(
        envelope(config, await overviewFor(match[1]), { providerStatus }),
      );
    }
  }

  {
    const match = /^site-audit\/history\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const runs = await store.latestRuns(
        match[1],
        clamp(url.searchParams.get("limit"), 20, 100) ?? 20,
      );
      return json(
        envelope(
          config,
          { entityId: match[1], runs: runs.map(projectRun) },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^site-audit\/runs\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const run = await store.getRun(match[1]);
      if (!run) return json({ error: "run not found" }, 404);
      const counts = await store.frontierCounts(run.id);
      return json(
        envelope(
          config,
          { run: projectRun(run), frontier: counts },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^site-audit\/pages\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const pages = await store.runPages(
        match[1],
        clamp(url.searchParams.get("limit"), 200, 1000) ?? 200,
      );
      return json(
        envelope(
          config,
          {
            runId: match[1],
            pages: pages.map((page) => ({
              id: page.id,
              url: page.url,
              statusCode: page.statusCode,
              contentType: page.contentType,
              responseTimeMs: page.responseTimeMs,
              depth: page.depth,
              title: page.title,
              metaDescription: page.metaDescription,
              h1Count: page.h1Count,
              indexable: page.indexable,
              indexabilityReason: page.indexabilityReason,
              textLength: page.textLength,
              internalLinkCount: page.internalLinkCount,
              externalLinkCount: page.externalLinkCount,
              imageCount: page.imageCount,
              imagesMissingAlt: page.imagesMissingAlt,
              inSitemap: page.inSitemap,
              canonicalUrl: page.canonicalUrl,
              redirectChainLength: page.redirectChainLength,
              fetchError: page.fetchError,
              crawledAt: page.crawledAt,
            })),
          },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^site-audit\/issues\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const issues = await issueStore.runIssues(match[1], {
        severity: url.searchParams.get("severity") ?? undefined,
        issueType: url.searchParams.get("issueType") ?? undefined,
        limit: clamp(url.searchParams.get("limit"), 200, 1000) ?? 200,
      });
      return json(
        envelope(
          config,
          { runId: match[1], issues: issues.map(projectIssue) },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^site-audit\/issue\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const issue = await issueStore.getIssue(match[1]);
      if (!issue) return json({ error: "issue not found" }, 404);
      return json(
        envelope(config, { issue: projectIssue(issue) }, { providerStatus }),
      );
    }
  }

  {
    // New & Resolved. The `unverified` list is part of the answer: an issue we
    // could not check is neither open nor fixed, and hiding that distinction is
    // how a partial crawl starts lying.
    const match = /^site-audit\/diff\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const current = await store.getRun(match[1]);
      if (!current) return json({ error: "run not found" }, 404);
      const previous = await store.lastComparableRun(
        current.entityId,
        current.id,
      );
      const [currentIssues, currentPages] = await Promise.all([
        issueStore.runIssues(current.id, { limit: 2000 }),
        store.runPages(current.id, 1000),
      ]);
      let before: DiffRun | null = null;
      if (previous) {
        const [previousIssues, previousPages] = await Promise.all([
          issueStore.runIssues(previous.id, { limit: 2000 }),
          store.runPages(previous.id, 1000),
        ]);
        before = toDiffRun(previous, previousIssues, previousPages);
      }
      const diff = diffAudits(
        toDiffRun(current, currentIssues, currentPages),
        before,
      );
      const events = await issueStore.issueEvents(
        current.id,
        url.searchParams.get("eventType") ?? undefined,
      );
      return json(
        envelope(
          config,
          {
            runId: current.id,
            previousRunId: previous?.id ?? null,
            diff,
            events: events.map((event) => ({
              id: event.id,
              issueType: event.issueType,
              pageUrl: event.pageUrl,
              eventType: event.eventType,
              severity: event.severity,
              reason: event.reason,
              occurredAt: event.occurredAt,
            })),
          },
          { providerStatus },
        ),
      );
    }
  }

  return null;
}

export async function dispatchSiteAuditOperations(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, config, providerStatus } = ctx;
  const method = request.method;

  if (route === "site-audit/request" && method === "POST") {
    const body = await readJson(request);
    const entityId = str(body.entity_id);
    if (!entityId) {
      return badRequest("entity_id_required", "entity_id is required");
    }
    const outcome = await service.requestAudit(config, {
      entityId,
      trigger: str(body.trigger) === "scheduled" ? "scheduled" : "manual",
      requestedBy: str(body.requested_by) ?? null,
      pageLimit: num(body.page_limit),
    });
    return json(envelope(config, { job: outcome }, { providerStatus }));
  }

  if (route === "site-audit/advance" && method === "POST") {
    const body = await readJson(request);
    const runId = str(body.run_id);
    if (!runId) return badRequest("run_id_required", "run_id is required");
    const outcome = await service.runAuditBatch(config, runId);
    return json(envelope(config, { job: outcome }, { providerStatus }));
  }

  if (route === "site-audit/tick" && method === "POST") {
    const result = await service.runAuditTick(config);
    return json(envelope(config, result, { providerStatus }));
  }

  {
    const match = /^site-audit\/issue\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "PATCH") {
      const body = await readJson(request);
      const status = body.status;
      if (status !== undefined && !isIssueStatus(status)) {
        return badRequest(
          "bad_status",
          `status must be one of ${ISSUE_STATUSES.join(", ")}`,
        );
      }
      const updated = await issueStore.updateIssueStatus(match[1], {
        status: isIssueStatus(status) ? status : undefined,
        reviewedBy: str(body.reviewed_by) ?? null,
        reviewNote:
          body.review_note === null
            ? null
            : (str(body.review_note) ?? undefined),
      });
      if (!updated) return json({ error: "issue not found" }, 404);
      return json(
        envelope(config, { issue: projectIssue(updated) }, { providerStatus }),
      );
    }
  }

  return null;
}
