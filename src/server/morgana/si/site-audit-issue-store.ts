import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  siSiteAuditIssueEvents,
  siSiteAuditIssues,
  siSiteAuditUsageLedger,
} from "@/db/schema";
import { newId, nowIso } from "./ids";
import { chunkForD1 } from "./d1-chunk";
import type { AuditIssue } from "./site-audit-checks";
import type { DiffEntry } from "./site-audit-diff";

/**
 * Morgana Search Intelligence — Site Audit issues, events and ledger.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Split from the crawl-state store: what the crawl DID (runs, frontier, pages)
 * and what the crawl FOUND (issues, their movements, what it cost us) are read
 * by different callers and change for different reasons.
 */

export type AuditIssueRow = typeof siSiteAuditIssues.$inferSelect;
type IssueEventRow = typeof siSiteAuditIssueEvents.$inferSelect;

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const EVENT_TYPES = [
  "new",
  "resolved",
  "worsened",
  "improved",
  "persistent",
] as const;

/** Predicates, not casts: the check and the narrowing cannot drift apart. */
function asSeverity(
  value: string | undefined,
): AuditIssueRow["severity"] | undefined {
  return SEVERITIES.find((candidate) => candidate === value);
}

function asEventType(
  value: string | undefined,
): IssueEventRow["eventType"] | undefined {
  return EVENT_TYPES.find((candidate) => candidate === value);
}

/**
 * Persist the issues of a run.
 *
 * `firstSeenAt` is carried over from the previous occurrence of the same issue
 * on the same page, which is what makes "open for three weeks" answerable. A
 * new row per run keeps each audit's findings intact and auditable.
 */
export async function saveIssues(
  runId: string,
  entityId: string,
  issues: readonly AuditIssue[],
  firstSeen: ReadonlyMap<string, string>,
): Promise<void> {
  if (issues.length === 0) return;
  const at = nowIso();
  // 19 columns per row; see `chunkForD1`.
  for (const chunk of chunkForD1(issues, 19)) {
    await db
      .insert(siSiteAuditIssues)
      .values(
        chunk.map((entry) => {
          const identity = `${entry.issueType}|${entry.pageUrl ?? "__site__"}`;
          return {
            id: newId("sai"),
            runId,
            entityId,
            pageId: null,
            pageUrl: entry.pageUrl,
            issueType: entry.issueType,
            category: entry.category,
            severity: entry.severity,
            status: "open" as const,
            details: JSON.stringify(entry.details).slice(0, 4000),
            changeState: "unknown" as const,
            firstSeenAt: firstSeen.get(identity) ?? at,
            lastSeenAt: at,
            dedupeKey: `${runId}|${identity}`.slice(0, 900),
            createdAt: at,
            updatedAt: at,
          };
        }),
      )
      .onConflictDoNothing({ target: siSiteAuditIssues.dedupeKey });
  }
}

export async function runIssues(
  runId: string,
  options: {
    severity?: string;
    issueType?: string;
    limit?: number;
  } = {},
): Promise<AuditIssueRow[]> {
  const filters = [eq(siSiteAuditIssues.runId, runId)];
  if (options.severity) {
    const severity = asSeverity(options.severity);
    // An unrecognised filter value narrows to nothing rather than being cast
    // into the column's type and matching nothing silently.
    if (severity) filters.push(eq(siSiteAuditIssues.severity, severity));
  }
  if (options.issueType) {
    filters.push(eq(siSiteAuditIssues.issueType, options.issueType));
  }
  return db
    .select()
    .from(siSiteAuditIssues)
    .where(and(...filters))
    .orderBy(asc(siSiteAuditIssues.severity), asc(siSiteAuditIssues.issueType))
    .limit(options.limit ?? 500);
}

export async function getIssue(id: string): Promise<AuditIssueRow | undefined> {
  const rows = await db
    .select()
    .from(siSiteAuditIssues)
    .where(eq(siSiteAuditIssues.id, id))
    .limit(1);
  return rows[0];
}

export async function updateIssueStatus(
  id: string,
  patch: {
    status?: AuditIssueRow["status"];
    reviewedBy?: string | null;
    reviewNote?: string | null;
  },
): Promise<AuditIssueRow | undefined> {
  const at = nowIso();
  await db
    .update(siSiteAuditIssues)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      // A human closing an issue is recorded as such; only the diff may set
      // `resolved_at` from evidence, and it does that through its own path.
      ...(patch.status === "resolved" ? { resolvedAt: at } : {}),
      ...(patch.reviewedBy === undefined
        ? {}
        : { reviewedBy: patch.reviewedBy }),
      ...(patch.reviewNote === undefined
        ? {}
        : { reviewNote: patch.reviewNote }),
      updatedAt: at,
    })
    .where(eq(siSiteAuditIssues.id, id));
  return getIssue(id);
}

/** First-seen timestamps for the issues of the previous run, by identity. */
export async function firstSeenMap(
  entityId: string,
  previousRunId: string | null,
): Promise<Map<string, string>> {
  if (!previousRunId) return new Map();
  const rows = await db
    .select({
      issueType: siSiteAuditIssues.issueType,
      pageUrl: siSiteAuditIssues.pageUrl,
      firstSeenAt: siSiteAuditIssues.firstSeenAt,
    })
    .from(siSiteAuditIssues)
    .where(
      and(
        eq(siSiteAuditIssues.entityId, entityId),
        eq(siSiteAuditIssues.runId, previousRunId),
      ),
    )
    .limit(5000);
  return new Map(
    rows.map((row) => [
      `${row.issueType}|${row.pageUrl ?? "__site__"}`,
      row.firstSeenAt,
    ]),
  );
}

export async function saveIssueEvents(
  runId: string,
  entityId: string,
  previousRunId: string | null,
  entries: readonly DiffEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const at = nowIso();
  let written = 0;
  // 12 columns per row; see `chunkForD1`.
  for (const chunk of chunkForD1(entries, 12)) {
    await db
      .insert(siSiteAuditIssueEvents)
      .values(
        chunk.map((entry) => ({
          id: newId("sae"),
          runId,
          entityId,
          issueType: entry.issueType,
          pageUrl: entry.pageUrl,
          eventType: entry.state,
          severity: entry.severity,
          previousRunId,
          reason: entry.reason.slice(0, 500),
          occurredAt: at,
          dedupeKey:
            `${runId}|${entry.issueType}|${entry.pageUrl ?? "__site__"}|${entry.state}`.slice(
              0,
              900,
            ),
          createdAt: at,
        })),
      )
      .onConflictDoNothing({ target: siSiteAuditIssueEvents.dedupeKey });
    written += chunk.length;
  }
  return written;
}

export async function issueEvents(
  runId: string,
  eventType?: string,
  limit = 200,
): Promise<(typeof siSiteAuditIssueEvents.$inferSelect)[]> {
  const filters = [eq(siSiteAuditIssueEvents.runId, runId)];
  const parsed = asEventType(eventType);
  if (parsed) filters.push(eq(siSiteAuditIssueEvents.eventType, parsed));
  return db
    .select()
    .from(siSiteAuditIssueEvents)
    .where(and(...filters))
    .orderBy(desc(siSiteAuditIssueEvents.occurredAt))
    .limit(limit);
}

// --- ledger ------------------------------------------------------------------

export async function recordUsage(input: {
  entityId: string | null;
  runId: string | null;
  requests?: number;
  pagesProcessed?: number;
  bytesFetched?: number;
  durationMs?: number;
  errors?: number;
  blocked?: number;
  cacheHits?: number;
  cacheMisses?: number;
}): Promise<void> {
  const at = nowIso();
  const day = at.slice(0, 10);
  const values = {
    requests: input.requests ?? 0,
    pagesProcessed: input.pagesProcessed ?? 0,
    bytesFetched: input.bytesFetched ?? 0,
    durationMs: input.durationMs ?? 0,
    errors: input.errors ?? 0,
    blocked: input.blocked ?? 0,
    cacheHits: input.cacheHits ?? 0,
    cacheMisses: input.cacheMisses ?? 0,
  };
  await db
    .insert(siSiteAuditUsageLedger)
    .values({
      id: newId("sau"),
      day,
      entityId: input.entityId,
      runId: input.runId,
      ...values,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [
        siSiteAuditUsageLedger.day,
        siSiteAuditUsageLedger.entityId,
        siSiteAuditUsageLedger.runId,
      ],
      set: {
        requests: sql`${siSiteAuditUsageLedger.requests} + ${values.requests}`,
        pagesProcessed: sql`${siSiteAuditUsageLedger.pagesProcessed} + ${values.pagesProcessed}`,
        bytesFetched: sql`${siSiteAuditUsageLedger.bytesFetched} + ${values.bytesFetched}`,
        durationMs: sql`${siSiteAuditUsageLedger.durationMs} + ${values.durationMs}`,
        errors: sql`${siSiteAuditUsageLedger.errors} + ${values.errors}`,
        blocked: sql`${siSiteAuditUsageLedger.blocked} + ${values.blocked}`,
        cacheHits: sql`${siSiteAuditUsageLedger.cacheHits} + ${values.cacheHits}`,
        cacheMisses: sql`${siSiteAuditUsageLedger.cacheMisses} + ${values.cacheMisses}`,
        updatedAt: at,
      },
    });
}

interface SiteAuditCostStatus {
  costCentre: string;
  /** Stated explicitly: this subsystem calls no paid provider at all. */
  providerCallsMade: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  requests: number;
  pagesProcessed: number;
  bytesFetched: number;
  durationMs: number;
  errors: number;
  blocked: number;
  cacheHits: number;
  cacheMisses: number;
  /** Null until something has been observed — an unmeasured rate is not zero. */
  cacheHitRate: number | null;
  averageMsPerPage: number | null;
}

export async function siteAuditCostStatus(
  options: { month?: string } = {},
): Promise<SiteAuditCostStatus> {
  const month = options.month ?? nowIso().slice(0, 7);
  const rows = await db
    .select({
      requests: sql<number>`coalesce(sum(${siSiteAuditUsageLedger.requests}), 0)`,
      pagesProcessed: sql<number>`coalesce(sum(${siSiteAuditUsageLedger.pagesProcessed}), 0)`,
      bytesFetched: sql<number>`coalesce(sum(${siSiteAuditUsageLedger.bytesFetched}), 0)`,
      durationMs: sql<number>`coalesce(sum(${siSiteAuditUsageLedger.durationMs}), 0)`,
      errors: sql<number>`coalesce(sum(${siSiteAuditUsageLedger.errors}), 0)`,
      blocked: sql<number>`coalesce(sum(${siSiteAuditUsageLedger.blocked}), 0)`,
      cacheHits: sql<number>`coalesce(sum(${siSiteAuditUsageLedger.cacheHits}), 0)`,
      cacheMisses: sql<number>`coalesce(sum(${siSiteAuditUsageLedger.cacheMisses}), 0)`,
    })
    .from(siSiteAuditUsageLedger)
    .where(sql`substr(${siSiteAuditUsageLedger.day}, 1, 7) = ${month}`);
  const row = rows[0];
  const pages = Number(row?.pagesProcessed ?? 0);
  const cacheTotal =
    Number(row?.cacheHits ?? 0) + Number(row?.cacheMisses ?? 0);
  const durationMs = Number(row?.durationMs ?? 0);
  return {
    costCentre: "site_audit_internal",
    providerCallsMade: 0,
    estimatedCostUsd: 0,
    actualCostUsd: 0,
    requests: Number(row?.requests ?? 0),
    pagesProcessed: pages,
    bytesFetched: Number(row?.bytesFetched ?? 0),
    durationMs,
    errors: Number(row?.errors ?? 0),
    blocked: Number(row?.blocked ?? 0),
    cacheHits: Number(row?.cacheHits ?? 0),
    cacheMisses: Number(row?.cacheMisses ?? 0),
    cacheHitRate:
      cacheTotal === 0 ? null : Number(row?.cacheHits ?? 0) / cacheTotal,
    averageMsPerPage: pages === 0 ? null : Math.round(durationMs / pages),
  };
}
