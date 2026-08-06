import { and, asc, gt, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  siBacklinks,
  siRankSnapshots,
  siReferringDomains,
  trackedKeywords,
} from "@/db/schema";
import * as graph from "./graph-store";
import * as timeline from "./graph-timeline-store";
import * as entityStore from "./store";
import { canonicalise } from "./graph-model";
import { nowIso } from "./ids";

/**
 * Morgana Search Intelligence — phase 4 incremental ingestion.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Turns already-collected records into nodes and edges. Nothing here fetches
 * anything or spends anything: phase 4 correlates what phases 1–3 already paid
 * for.
 *
 * **Incremental by construction.** Each source is read from its checkpoint
 * forward, in bounded batches. A full rebuild every tick would be slow now and
 * impossible later — Morgana's mention table has no ceiling.
 */

/** Bounded so one tick cannot exhaust the subrequest budget. */
const BATCH = 200;

export interface IngestResult {
  source: string;
  processed: number;
  nodes: number;
  edges: number;
  cursor: string | null;
  status: "ok" | "partial" | "failed";
  reason?: string;
}

/** Facts Morgana pushes in; the engine cannot read them for itself. */
export interface BrandFact {
  kind: "mention" | "article" | "telegram" | "social";
  externalId: string;
  url?: string | null;
  title?: string | null;
  sourceName?: string | null;
  channel?: string | null;
  sentiment?: "positive" | "neutral" | "negative" | null;
  observedAt: string;
}

/**
 * Ingest Brand Monitoring facts.
 *
 * They arrive on the request rather than being read from a database, because
 * the engine has no access to Morgana's D1 and must not acquire any. Morgana
 * owns the cursor and sends only what is new.
 */
export async function ingestBrandFacts(
  facts: readonly BrandFact[],
): Promise<IngestResult> {
  let nodes = 0;
  let edges = 0;
  const brandNodeId = await primaryBrandNode();

  for (const fact of facts.slice(0, BATCH)) {
    const nodeType =
      fact.kind === "telegram"
        ? "telegram_channel"
        : fact.kind === "social"
          ? "social_profile"
          : fact.kind;
    const rawIdentity = fact.channel ?? fact.url ?? fact.externalId;
    const canonical = canonicalise(nodeType, rawIdentity);
    if (!canonical) continue;

    const nodeId = await graph.upsertNode({
      nodeType,
      label: fact.title ?? fact.channel ?? fact.url ?? fact.externalId,
      canonicalValue: canonical,
      externalId: fact.externalId,
      sourceSystem: "morgana",
      metadata: {
        sentiment: fact.sentiment ?? null,
        sourceName: fact.sourceName ?? null,
      },
      observedAt: fact.observedAt,
    });
    if (!nodeId) continue;
    nodes += 1;

    if (brandNodeId) {
      const edgeId = await graph.upsertEdge({
        sourceNodeId: nodeId,
        targetNodeId: brandNodeId,
        edgeType: "MENTIONS",
        observedAt: fact.observedAt,
      });
      if (edgeId) {
        edges += 1;
        await graph.recordEvidence({
          subjectType: "edge",
          subjectId: edgeId,
          evidenceType: `${fact.kind}_observed`,
          sourceRecordId: fact.externalId,
          sourceSystem: "morgana",
          observedAt: fact.observedAt,
          reason: `${fact.kind} che cita il brand: ${(fact.title ?? fact.url ?? fact.externalId).slice(0, 120)}`,
        });
      }
    }

    // The publishing domain is its own node, so an article and a backlink from
    // the same site converge instead of staying in separate subgraphs.
    if (fact.url) {
      const linked = await linkPublishingDomain(
        fact.url,
        nodeId,
        fact.observedAt,
      );
      nodes += linked.nodes;
      edges += linked.edges;
    }

    await timeline.appendTimelineEvents([
      {
        occurredAt: fact.observedAt,
        eventType: "mention",
        entityNodeId: nodeId,
        entityLabel: fact.sourceName ?? fact.channel ?? "mention",
        summary: (fact.title ?? fact.url ?? fact.externalId).slice(0, 200),
        severity: fact.sentiment === "negative" ? "warning" : "info",
        sourceSystem: "morgana",
        sourceRecordId: fact.externalId,
        evidenceRef: fact.url ?? null,
      },
    ]);
  }

  const cursor = facts.at(-1)?.observedAt ?? null;
  return {
    source: "morgana_brand_facts",
    processed: Math.min(facts.length, BATCH),
    nodes,
    edges,
    cursor,
    status: facts.length > BATCH ? "partial" : "ok",
  };
}

/**
 * Attach a fact to the domain that published it.
 *
 * Extracted rather than inlined so the ingest loop stays readable — five levels
 * of nesting is where a loop stops being reviewable.
 */
async function linkPublishingDomain(
  url: string,
  factNodeId: string,
  observedAt: string,
): Promise<{ nodes: number; edges: number }> {
  const domain = canonicalise("domain", url);
  if (!domain) return { nodes: 0, edges: 0 };
  const domainNodeId = await graph.upsertNode({
    nodeType: "domain",
    label: domain,
    canonicalValue: domain,
    sourceSystem: "morgana",
    observedAt,
  });
  if (!domainNodeId) return { nodes: 0, edges: 0 };
  const edgeId = await graph.upsertEdge({
    sourceNodeId: domainNodeId,
    targetNodeId: factNodeId,
    edgeType: "PUBLISHED",
    observedAt,
  });
  return { nodes: 1, edges: edgeId ? 1 : 0 };
}

/** The brand node every Morgana fact attaches to. */
async function primaryBrandNode(): Promise<string | null> {
  const entities = await entityStore.listEntities();
  const primary = entities.find((entity) => entity.entityType === "primary");
  if (!primary) return null;
  const canonical = canonicalise("brand", primary.canonicalDomain);
  return graph.upsertNode({
    nodeType: "brand",
    label: primary.displayName,
    canonicalValue: canonical,
    externalId: primary.id,
    sourceSystem: "search_intelligence",
  });
}

/** Entities become brand and competitor nodes, joined by COMPETES_WITH. */
export async function ingestEntities(): Promise<IngestResult> {
  const entities = await entityStore.listEntities();
  const primary = entities.find((entity) => entity.entityType === "primary");
  let nodes = 0;
  let edges = 0;

  const brandNodeId = primary ? await primaryBrandNode() : null;
  if (brandNodeId) nodes += 1;

  for (const entity of entities.filter(
    (candidate) => candidate.entityType !== "primary",
  )) {
    const canonical = canonicalise("competitor", entity.canonicalDomain);
    if (!canonical) continue;
    const nodeId = await graph.upsertNode({
      nodeType: "competitor",
      label: entity.displayName,
      canonicalValue: canonical,
      externalId: entity.id,
      sourceSystem: "search_intelligence",
    });
    if (!nodeId) continue;
    nodes += 1;
    if (
      brandNodeId &&
      (await graph.upsertEdge({
        sourceNodeId: brandNodeId,
        targetNodeId: nodeId,
        edgeType: "COMPETES_WITH",
      }))
    ) {
      edges += 1;
    }
  }

  return {
    source: "si_entities",
    processed: entities.length,
    nodes,
    edges,
    cursor: nowIso(),
    status: "ok",
  };
}

/** Tracked keywords and their rank observations. */
export async function ingestSearchData(): Promise<IngestResult> {
  const cursor = await timeline.getCheckpoint("si_rank_snapshots");
  const rows = await db
    .select()
    .from(siRankSnapshots)
    .where(cursor ? gt(siRankSnapshots.createdAt, cursor) : undefined)
    .orderBy(asc(siRankSnapshots.createdAt))
    .limit(BATCH);

  let nodes = 0;
  let edges = 0;
  const keywordNodeCache = new Map<string, string>();

  for (const row of rows) {
    let keywordNodeId = keywordNodeCache.get(row.trackedKeywordId);
    if (!keywordNodeId) {
      const keyword = (
        await db
          .select()
          .from(trackedKeywords)
          .where(eq(trackedKeywords.id, row.trackedKeywordId))
          .limit(1)
      )[0];
      if (!keyword) continue;
      const created = await graph.upsertNode({
        nodeType: "keyword",
        label: keyword.keyword,
        canonicalValue: keyword.normalizedKeyword,
        externalId: keyword.id,
        sourceSystem: "search_intelligence",
      });
      if (!created) continue;
      keywordNodeId = created;
      keywordNodeCache.set(row.trackedKeywordId, created);
      nodes += 1;
    }

    const entity = await entityStore.getEntity(row.entityId);
    if (!entity) continue;
    const entityNodeId = await graph.upsertNode({
      nodeType: entity.entityType === "primary" ? "brand" : "competitor",
      label: entity.displayName,
      canonicalValue: canonicalise("domain", entity.canonicalDomain),
      externalId: entity.id,
      sourceSystem: "search_intelligence",
    });
    if (!entityNodeId) continue;

    // Only a found position is a RANKS_FOR edge. Asserting the edge for an
    // unranked observation would claim a relationship the data denies.
    if (
      row.isFound &&
      (await graph.upsertEdge({
        sourceNodeId: entityNodeId,
        targetNodeId: keywordNodeId,
        edgeType: "RANKS_FOR",
        weight:
          row.rankGroup === null ? 1 : Math.max(0.1, 1 - row.rankGroup / 100),
        metadata: { rank: row.rankGroup },
        observedAt: row.createdAt,
      }))
    ) {
      edges += 1;
    }
  }

  return {
    source: "si_rank_snapshots",
    processed: rows.length,
    nodes,
    edges,
    cursor: rows.at(-1)?.createdAt ?? cursor,
    status: rows.length === BATCH ? "partial" : "ok",
  };
}

/** Backlinks and referring domains, from the phase-3 tables. */
export async function ingestBacklinkData(): Promise<IngestResult> {
  const cursor = await timeline.getCheckpoint("si_backlinks");
  const rows = await db
    .select()
    .from(siBacklinks)
    .where(cursor ? gt(siBacklinks.createdAt, cursor) : undefined)
    .orderBy(asc(siBacklinks.createdAt))
    .limit(BATCH);

  let nodes = 0;
  let edges = 0;

  for (const row of rows) {
    const entity = await entityStore.getEntity(row.targetEntityId);
    if (!entity) continue;

    const sourceNodeId = await graph.upsertNode({
      nodeType: "referring_domain",
      label: row.sourceDomain,
      canonicalValue: row.normalizedSourceDomain,
      sourceSystem: "search_intelligence",
      observedAt: row.firstSeenAt,
    });
    const targetNodeId = await graph.upsertNode({
      nodeType: entity.entityType === "primary" ? "brand" : "competitor",
      label: entity.displayName,
      canonicalValue: canonicalise("domain", entity.canonicalDomain),
      externalId: entity.id,
      sourceSystem: "search_intelligence",
    });
    if (!sourceNodeId || !targetNodeId) continue;
    nodes += 2;

    const edgeId = await graph.upsertEdge({
      sourceNodeId,
      targetNodeId,
      edgeType: "LINKS_TO",
      metadata: { anchor: row.anchorText, dofollow: row.isDofollow },
      observedAt: row.firstSeenAt,
    });
    if (edgeId) {
      edges += 1;
      await graph.recordEvidence({
        subjectType: "edge",
        subjectId: edgeId,
        evidenceType: "backlink_observed",
        sourceRecordId: row.id,
        sourceSystem: "search_intelligence",
        observedAt: row.firstSeenAt,
        reason: `backlink da ${row.sourceDomain}${row.anchorText ? ` con anchor "${row.anchorText.slice(0, 60)}"` : " senza anchor"}`,
      });
    }
  }

  return {
    source: "si_backlinks",
    processed: rows.length,
    nodes,
    edges,
    cursor: rows.at(-1)?.createdAt ?? cursor,
    status: rows.length === BATCH ? "partial" : "ok",
  };
}

/**
 * Suspicious referring domains become finding nodes with IMPERSONATES edges.
 *
 * This is where phase 3's risk model reaches the graph, and it is what lets a
 * suspicious domain be traced to the Telegram channel that also mentions it.
 */
export async function ingestFindings(): Promise<IngestResult> {
  const rows = await db
    .select()
    .from(siReferringDomains)
    .where(
      and(
        eq(siReferringDomains.status, "active"),
        // Only suspicious and above: a `review` domain is not an assertion.
        gt(siReferringDomains.riskScore, 49),
      ),
    )
    .limit(BATCH);

  let nodes = 0;
  let edges = 0;
  const brandNodeId = await primaryBrandNode();

  for (const row of rows) {
    const domainNodeId = await graph.upsertNode({
      nodeType: "referring_domain",
      label: row.domain,
      canonicalValue: row.normalizedDomain,
      sourceSystem: "search_intelligence",
      metadata: {
        riskScore: row.riskScore,
        riskClassification: row.riskClassification,
      },
      observedAt: row.firstSeenAt,
    });
    if (!domainNodeId || !brandNodeId) continue;
    nodes += 1;

    const edgeId = await graph.upsertEdge({
      sourceNodeId: domainNodeId,
      targetNodeId: brandNodeId,
      edgeType: "IMPERSONATES",
      weight: (row.riskScore ?? 50) / 100,
      metadata: { riskClassification: row.riskClassification },
      observedAt: row.lastSeenAt,
    });
    if (edgeId) {
      edges += 1;
      await graph.recordEvidence({
        subjectType: "edge",
        subjectId: edgeId,
        evidenceType: "backlink_risk_finding",
        sourceRecordId: row.id,
        sourceSystem: "search_intelligence",
        observedAt: row.lastSeenAt,
        // Phrased as a signal requiring review. Phase 3's rule holds here too.
        reason: `segnale di possibile impersonificazione: rischio ${String(row.riskScore ?? 0)}/100 (${row.riskClassification ?? "non classificato"})`,
      });
    }
  }

  return {
    source: "si_findings",
    processed: rows.length,
    nodes,
    edges,
    cursor: nowIso(),
    status: "ok",
  };
}
