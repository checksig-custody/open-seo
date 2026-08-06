import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  siSiteAuditFrontier,
  siSiteAuditLinks,
  siSiteAuditPages,
  siSiteAuditRuns,
} from "@/db/schema";
import { chunkForD1 } from "./d1-chunk";
import { newId, nowIso } from "./ids";

/**
 * Morgana Search Intelligence — Site Audit persistence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Every write is idempotent through a UNIQUE key, for the same reason phase 4's
 * graph is: a crawl spans several Worker invocations and any of them can be
 * retried. Replaying a batch must converge, never duplicate.
 */

export type AuditRunRow = typeof siSiteAuditRuns.$inferSelect;
export type AuditPageRow = typeof siSiteAuditPages.$inferSelect;
type FrontierRow = typeof siSiteAuditFrontier.$inferSelect;

export function runDedupeKey(
  entityId: string,
  trigger: "manual" | "scheduled",
  at: Date = new Date(),
): string {
  // Manual runs carry the hour as well: an operator repeating a run the same
  // day is legitimate, while a scheduler doing so is a bug.
  const stamp =
    trigger === "manual"
      ? at.toISOString().slice(0, 13)
      : at.toISOString().slice(0, 10);
  return `${entityId}|${trigger}|${stamp}`;
}

export async function createRun(input: {
  entityId: string;
  trigger: "manual" | "scheduled";
  requestedBy?: string | null;
  pageLimit: number;
  dedupeKey: string;
}): Promise<{ run: AuditRunRow; created: boolean }> {
  const at = nowIso();
  const id = newId("sar");
  await db
    .insert(siSiteAuditRuns)
    .values({
      id,
      entityId: input.entityId,
      status: "queued",
      trigger: input.trigger,
      requestedBy: input.requestedBy ?? null,
      pageLimit: input.pageLimit,
      dedupeKey: input.dedupeKey,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing({ target: siSiteAuditRuns.dedupeKey });

  const rows = await db
    .select()
    .from(siSiteAuditRuns)
    .where(eq(siSiteAuditRuns.dedupeKey, input.dedupeKey))
    .limit(1);
  const run = rows[0];
  if (!run) throw new Error("audit run insert did not persist");
  return { run, created: run.id === id };
}

export async function getRun(id: string): Promise<AuditRunRow | undefined> {
  const rows = await db
    .select()
    .from(siSiteAuditRuns)
    .where(eq(siSiteAuditRuns.id, id))
    .limit(1);
  return rows[0];
}

export async function updateRun(
  id: string,
  patch: Partial<Omit<AuditRunRow, "id" | "createdAt">>,
): Promise<void> {
  await db
    .update(siSiteAuditRuns)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(siSiteAuditRuns.id, id));
}

export async function latestRuns(
  entityId: string,
  limit = 20,
): Promise<AuditRunRow[]> {
  return db
    .select()
    .from(siSiteAuditRuns)
    .where(eq(siSiteAuditRuns.entityId, entityId))
    .orderBy(desc(siSiteAuditRuns.createdAt))
    .limit(limit);
}

/** The newest run in a state that can be compared against. */
export async function lastComparableRun(
  entityId: string,
  excludeRunId: string,
): Promise<AuditRunRow | undefined> {
  const rows = await db
    .select()
    .from(siSiteAuditRuns)
    .where(
      and(
        eq(siSiteAuditRuns.entityId, entityId),
        eq(siSiteAuditRuns.status, "completed"),
        eq(siSiteAuditRuns.comparisonStatus, "complete"),
        ne(siSiteAuditRuns.id, excludeRunId),
      ),
    )
    .orderBy(desc(siSiteAuditRuns.createdAt))
    .limit(1);
  return rows[0];
}

/** Is a crawl already in flight for this domain? Only one may run at a time. */
export async function activeRunFor(
  entityId: string,
): Promise<AuditRunRow | undefined> {
  const rows = await db
    .select()
    .from(siSiteAuditRuns)
    .where(
      and(
        eq(siSiteAuditRuns.entityId, entityId),
        inArray(siSiteAuditRuns.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(siSiteAuditRuns.createdAt))
    .limit(1);
  return rows[0];
}

export async function claimableRuns(limit = 3): Promise<AuditRunRow[]> {
  return db
    .select()
    .from(siSiteAuditRuns)
    .where(inArray(siSiteAuditRuns.status, ["queued", "running"]))
    .orderBy(asc(siSiteAuditRuns.createdAt))
    .limit(limit);
}

// --- frontier ----------------------------------------------------------------

export async function enqueue(
  runId: string,
  entries: readonly {
    normalizedUrl: string;
    depth: number;
    discoveredFrom?: string | null;
    discoverySource?: "seed" | "sitemap" | "link" | "redirect";
    state?: "pending" | "skipped" | "blocked";
    skipReason?: string | null;
  }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const at = nowIso();
  let inserted = 0;
  // Chunked by BOUND PARAMETERS, not by rows: D1 caps them at 100 per
  // statement, and a link-heavy page can discover hundreds of URLs at once.
  // 11 columns per row.
  for (const chunk of chunkForD1(entries, 11)) {
    await db
      .insert(siSiteAuditFrontier)
      .values(
        chunk.map((entry) => ({
          id: newId("saf"),
          runId,
          normalizedUrl: entry.normalizedUrl.slice(0, 2048),
          depth: entry.depth,
          discoveredFrom: entry.discoveredFrom ?? null,
          discoverySource: entry.discoverySource ?? "link",
          state: entry.state ?? ("pending" as const),
          skipReason: entry.skipReason ?? null,
          createdAt: at,
          updatedAt: at,
        })),
      )
      .onConflictDoNothing({
        target: [siSiteAuditFrontier.runId, siSiteAuditFrontier.normalizedUrl],
      });
    inserted += chunk.length;
  }
  return inserted;
}

export async function nextBatch(
  runId: string,
  limit: number,
): Promise<FrontierRow[]> {
  return (
    db
      .select()
      .from(siSiteAuditFrontier)
      .where(
        and(
          eq(siSiteAuditFrontier.runId, runId),
          eq(siSiteAuditFrontier.state, "pending"),
        ),
      )
      // Breadth-first: shallow pages first, so a truncated crawl still covers the
      // pages that matter most rather than a deep corner of the site.
      .orderBy(
        asc(siSiteAuditFrontier.depth),
        asc(siSiteAuditFrontier.createdAt),
      )
      .limit(limit)
  );
}

export async function markFrontier(
  ids: readonly string[],
  state: "in_progress" | "done" | "skipped" | "blocked",
  skipReason?: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(siSiteAuditFrontier)
    .set({
      state,
      skipReason: skipReason ?? null,
      attempts: sql`${siSiteAuditFrontier.attempts} + 1`,
      updatedAt: nowIso(),
    })
    .where(inArray(siSiteAuditFrontier.id, [...ids]));
}

export async function frontierCounts(
  runId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      state: siSiteAuditFrontier.state,
      total: sql<number>`count(*)`,
    })
    .from(siSiteAuditFrontier)
    .where(eq(siSiteAuditFrontier.runId, runId))
    .groupBy(siSiteAuditFrontier.state);
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.total)]));
}

export async function knownUrls(runId: string): Promise<string[]> {
  const rows = await db
    .select({ url: siSiteAuditFrontier.normalizedUrl })
    .from(siSiteAuditFrontier)
    .where(eq(siSiteAuditFrontier.runId, runId));
  return rows.map((row) => row.url);
}

// --- pages, links, issues ----------------------------------------------------

export async function savePage(
  page: typeof siSiteAuditPages.$inferInsert,
): Promise<string> {
  const id = page.id;
  await db
    .insert(siSiteAuditPages)
    .values(page)
    .onConflictDoUpdate({
      target: [siSiteAuditPages.runId, siSiteAuditPages.normalizedUrl],
      set: {
        statusCode: page.statusCode ?? null,
        contentType: page.contentType ?? null,
        responseTimeMs: page.responseTimeMs ?? null,
        title: page.title ?? null,
        metaDescription: page.metaDescription ?? null,
        h1Count: page.h1Count ?? 0,
        firstH1: page.firstH1 ?? null,
        robotsDirective: page.robotsDirective ?? null,
        indexable: page.indexable ?? null,
        indexabilityReason: page.indexabilityReason ?? null,
        contentLength: page.contentLength ?? null,
        textLength: page.textLength ?? null,
        internalLinkCount: page.internalLinkCount ?? 0,
        externalLinkCount: page.externalLinkCount ?? 0,
        imageCount: page.imageCount ?? 0,
        imagesMissingAlt: page.imagesMissingAlt ?? 0,
        contentHash: page.contentHash ?? null,
        canonicalUrl: page.canonicalUrl ?? null,
        redirectChainLength: page.redirectChainLength ?? 0,
        finalUrl: page.finalUrl ?? null,
        fetchError: page.fetchError ?? null,
        crawledAt: page.crawledAt,
      },
    });
  return id;
}

export async function saveLinks(
  runId: string,
  links: readonly {
    sourceUrl: string;
    targetUrl: string;
    anchorText: string | null;
    linkType: "internal" | "external";
    rel: string | null;
  }[],
): Promise<void> {
  if (links.length === 0) return;
  const at = nowIso();
  // 9 columns per row; see `chunkForD1`.
  for (const chunk of chunkForD1(links, 9)) {
    await db
      .insert(siSiteAuditLinks)
      .values(
        chunk.map((link) => ({
          id: newId("sal"),
          runId,
          sourceUrl: link.sourceUrl.slice(0, 2048),
          targetUrl: link.targetUrl.slice(0, 2048),
          anchorText: link.anchorText?.slice(0, 200) ?? null,
          linkType: link.linkType,
          rel: link.rel,
          dedupeKey: `${runId}|${link.sourceUrl}|${link.targetUrl}`.slice(
            0,
            900,
          ),
          createdAt: at,
        })),
      )
      .onConflictDoNothing({ target: siSiteAuditLinks.dedupeKey });
  }
}

export async function runPages(
  runId: string,
  limit = 500,
): Promise<AuditPageRow[]> {
  return db
    .select()
    .from(siSiteAuditPages)
    .where(eq(siSiteAuditPages.runId, runId))
    .orderBy(asc(siSiteAuditPages.depth))
    .limit(limit);
}

/** Internal link targets, for orphan and broken-link detection. */
export async function internalLinkTargets(
  runId: string,
): Promise<{ sourceUrl: string; targetUrl: string }[]> {
  return db
    .select({
      sourceUrl: siSiteAuditLinks.sourceUrl,
      targetUrl: siSiteAuditLinks.targetUrl,
    })
    .from(siSiteAuditLinks)
    .where(
      and(
        eq(siSiteAuditLinks.runId, runId),
        eq(siSiteAuditLinks.linkType, "internal"),
      ),
    )
    .limit(20_000);
}
