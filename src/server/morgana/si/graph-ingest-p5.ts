import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import {
  siAiVisibilityCitations,
  siAiVisibilitySnapshots,
  siAiVisibilityQueries,
  siSiteAuditIssues,
  siSiteAuditPages,
} from "@/db/schema";
import * as graph from "./graph-store";
import * as timeline from "./graph-timeline-store";
import * as entityStore from "./store";
import { normalizeDomain } from "./ai-visibility";
import type { IngestResult } from "./graph-ingest";

/**
 * Morgana Search Intelligence — phase 5 graph ingestion.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Incremental, like every other source: each pass reads from where the last one
 * stopped, using the same checkpoint table phase 4 introduced. The graph is
 * never rebuilt — a full rebuild would be O(everything) on every tick and would
 * throw away the observation counts that make an edge credible.
 *
 * What phase 5 adds to the graph is the two things phase 4 could not see: what
 * our own pages look like, and where an AI answer says its information came
 * from. The interesting queries are the joins those enable — a page with an
 * indexability problem that used to be cited, a suspicious domain from phase 3
 * now appearing as a source, a competitor cited on a question we care about.
 *
 * What it deliberately does NOT do: create a campaign. A single AI observation
 * is one signal from one family, and phase 4's rule — three signals from two
 * independent families — exists precisely so that one observation cannot become
 * a story on its own.
 */

const BATCH = 200;

/** Audit pages and their issues. */
export async function ingestAuditData(): Promise<IngestResult> {
  const cursor = await timeline.getCheckpoint("si_site_audit_pages");
  const rows = await db
    .select()
    .from(siSiteAuditPages)
    .where(cursor ? gt(siSiteAuditPages.crawledAt, cursor) : undefined)
    .orderBy(asc(siSiteAuditPages.crawledAt))
    .limit(BATCH);

  let nodes = 0;
  let edges = 0;
  const entityNodes = new Map<string, string>();

  for (const row of rows) {
    let entityNodeId = entityNodes.get(row.entityId);
    if (!entityNodeId) {
      const entity = await entityStore.getEntity(row.entityId);
      if (!entity) continue;
      const created = await graph.upsertNode({
        nodeType: entity.entityType === "primary" ? "brand" : "competitor",
        label: entity.displayName,
        canonicalValue: entity.normalizedDomain,
        externalId: entity.id,
        sourceSystem: "search_intelligence",
      });
      if (!created) continue;
      entityNodeId = created;
      entityNodes.set(row.entityId, created);
      nodes += 1;
    }

    const pageNodeId = await graph.upsertNode({
      nodeType: "audit_page",
      label: row.title ?? row.url,
      canonicalValue: row.normalizedUrl,
      externalId: row.id,
      sourceSystem: "search_intelligence",
      // Small display hints only — the page row stays the system of record.
      metadata: {
        statusCode: row.statusCode,
        indexable: row.indexable,
        depth: row.depth,
      },
      observedAt: row.crawledAt,
    });
    if (!pageNodeId) continue;
    nodes += 1;

    if (
      await graph.upsertEdge({
        sourceNodeId: entityNodeId,
        targetNodeId: pageNodeId,
        edgeType: "PUBLISHED",
        weight: 1,
        observedAt: row.crawledAt,
      })
    ) {
      edges += 1;
    }
  }

  return {
    source: "si_site_audit_pages",
    processed: rows.length,
    nodes,
    edges,
    cursor: rows.at(-1)?.crawledAt ?? cursor,
    status: rows.length === BATCH ? "partial" : "ok",
  };
}

/**
 * Audit issues, but only the ones worth a node.
 *
 * `critical` and `high` only. A node per missing alt attribute would bury the
 * graph in rows nobody will ever traverse, and the issue table is already the
 * place to read them.
 */
export async function ingestAuditIssues(): Promise<IngestResult> {
  const cursor = await timeline.getCheckpoint("si_site_audit_issues");
  const rows = await db
    .select()
    .from(siSiteAuditIssues)
    .where(
      cursor
        ? and(
            gt(siSiteAuditIssues.createdAt, cursor),
            eq(siSiteAuditIssues.status, "open"),
          )
        : eq(siSiteAuditIssues.status, "open"),
    )
    .orderBy(asc(siSiteAuditIssues.createdAt))
    .limit(BATCH);

  let nodes = 0;
  let edges = 0;
  for (const row of rows) {
    if (row.severity !== "critical" && row.severity !== "high") continue;
    const issueNodeId = await graph.upsertNode({
      nodeType: "audit_issue",
      label: `${row.issueType} — ${row.pageUrl ?? "site"}`,
      canonicalValue: `${row.issueType}|${row.pageUrl ?? "__site__"}`,
      externalId: row.id,
      sourceSystem: "search_intelligence",
      metadata: { severity: row.severity, category: row.category },
      observedAt: row.lastSeenAt,
    });
    if (!issueNodeId) continue;
    nodes += 1;

    if (!row.pageUrl) continue;
    const pageNode = await graph.findNode("audit_page", row.pageUrl);
    if (!pageNode) continue;
    if (
      await graph.upsertEdge({
        sourceNodeId: pageNode.id,
        targetNodeId: issueNodeId,
        edgeType: "HAS_AUDIT_ISSUE",
        weight: row.severity === "critical" ? 1 : 0.6,
        observedAt: row.lastSeenAt,
      })
    ) {
      edges += 1;
    }
    await graph.recordEvidence({
      subjectType: "edge",
      subjectId: issueNodeId,
      evidenceType: `audit_${row.issueType}`,
      sourceRecordId: row.id,
      sourceSystem: "search_intelligence",
      observedAt: row.lastSeenAt,
      weight: row.severity === "critical" ? 3 : 2,
      reason: `site audit found ${row.issueType} on ${row.pageUrl}`,
    });
  }

  return {
    source: "si_site_audit_issues",
    processed: rows.length,
    nodes,
    edges,
    cursor: rows.at(-1)?.createdAt ?? cursor,
    status: rows.length === BATCH ? "partial" : "ok",
  };
}

/**
 * AI queries and the domains cited in their answers.
 *
 * A citation is a `CITES` edge from the cited domain to the query, and a
 * mention is `MENTIONS_IN_AI_RESULT` from the brand. Two edge types because
 * they are two claims: being named and being used as a source are not the same
 * thing, and a graph that merged them would let the weaker one inherit the
 * authority of the stronger.
 */
export async function ingestAiVisibility(): Promise<IngestResult> {
  const cursor = await timeline.getCheckpoint("si_ai_visibility_citations");
  const rows = await db
    .select()
    .from(siAiVisibilityCitations)
    .where(cursor ? gt(siAiVisibilityCitations.createdAt, cursor) : undefined)
    .orderBy(asc(siAiVisibilityCitations.createdAt))
    .limit(BATCH);

  let nodes = 0;
  let edges = 0;
  const queryNodes = new Map<string, string>();

  for (const row of rows) {
    let queryNodeId = queryNodes.get(row.queryId);
    if (!queryNodeId) {
      const query = (
        await db
          .select()
          .from(siAiVisibilityQueries)
          .where(eq(siAiVisibilityQueries.id, row.queryId))
          .limit(1)
      )[0];
      if (!query) continue;
      const created = await graph.upsertNode({
        nodeType: "ai_query",
        label: query.query,
        canonicalValue: query.normalizedQuery,
        externalId: query.id,
        sourceSystem: "search_intelligence",
        metadata: { priority: query.priority, cluster: query.cluster },
      });
      if (!created) continue;
      queryNodeId = created;
      queryNodes.set(row.queryId, created);
      nodes += 1;
    }

    // A cited domain that is one of ours resolves to the brand/competitor node
    // rather than a new `cited_domain` node — same identity, one node. That is
    // the whole reason the graph is worth having.
    const domain = normalizeDomain(row.normalizedDomain);
    let domainNodeId: string | null = null;
    if (row.entityId) {
      const entity = await entityStore.getEntity(row.entityId);
      if (entity) {
        domainNodeId = await graph.upsertNode({
          nodeType: entity.entityType === "primary" ? "brand" : "competitor",
          label: entity.displayName,
          canonicalValue: entity.normalizedDomain,
          externalId: entity.id,
          sourceSystem: "search_intelligence",
        });
      }
    }
    domainNodeId ??= await graph.upsertNode({
      nodeType: "cited_domain",
      label: row.domain,
      canonicalValue: domain,
      sourceSystem: "search_intelligence",
      observedAt: row.firstSeenAt,
    });
    if (!domainNodeId) continue;
    nodes += 1;

    if (
      await graph.upsertEdge({
        sourceNodeId: domainNodeId,
        targetNodeId: queryNodeId,
        edgeType: "CITES",
        // Citation order is a real signal: the first source carries more
        // weight than the eighth, and flattening them would lose that.
        weight: Math.max(0.2, 1 - row.citationOrder * 0.1),
        metadata: { citationOrder: row.citationOrder },
        observedAt: row.firstSeenAt,
      })
    ) {
      edges += 1;
    }
    if (row.url) {
      const pageNode = await graph.findNode("audit_page", row.url);
      if (
        pageNode &&
        (await graph.upsertEdge({
          sourceNodeId: queryNodeId,
          targetNodeId: pageNode.id,
          edgeType: "REFERENCES_PAGE",
          weight: 1,
          observedAt: row.firstSeenAt,
        }))
      ) {
        edges += 1;
      }
    }
  }

  // Mentions without a citation: recorded separately so "named but not used as
  // a source" stays visible instead of disappearing into the citation count.
  const snapshotCursor = await timeline.getCheckpoint(
    "si_ai_visibility_mentions",
  );
  const snapshots = await db
    .select()
    .from(siAiVisibilitySnapshots)
    .where(
      snapshotCursor
        ? gt(siAiVisibilitySnapshots.checkedAt, snapshotCursor)
        : undefined,
    )
    .orderBy(asc(siAiVisibilitySnapshots.checkedAt))
    .limit(BATCH);

  for (const snapshot of snapshots) {
    if (snapshot.primaryBrandMentioned !== true) continue;
    const queryNodeId = queryNodes.get(snapshot.queryId);
    if (!queryNodeId) continue;
    const primary = (await entityStore.listEntities()).find(
      (entity) => entity.entityType === "primary",
    );
    if (!primary) continue;
    const brandNodeId = await graph.upsertNode({
      nodeType: "brand",
      label: primary.displayName,
      canonicalValue: primary.normalizedDomain,
      externalId: primary.id,
      sourceSystem: "search_intelligence",
    });
    if (
      brandNodeId &&
      (await graph.upsertEdge({
        sourceNodeId: brandNodeId,
        targetNodeId: queryNodeId,
        edgeType: "MENTIONS_IN_AI_RESULT",
        weight: snapshot.primaryBrandCited === true ? 1 : 0.5,
        metadata: { cited: snapshot.primaryBrandCited },
        observedAt: snapshot.checkedAt,
      }))
    ) {
      edges += 1;
    }
  }

  return {
    source: "si_ai_visibility",
    processed: rows.length + snapshots.length,
    nodes,
    edges,
    cursor: rows.at(-1)?.createdAt ?? cursor,
    status: rows.length === BATCH ? "partial" : "ok",
  };
}
// There is deliberately no `ingestPhase5()` convenience wrapper. The three
// steps are listed individually in `correlation-service.ts` because each one
// saves its own checkpoint after it returns; a wrapper that ran all three and
// returned an array would make it easy to lose that per-source cursor, which is
// the whole reason ingestion is incremental.
