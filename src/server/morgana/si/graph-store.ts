import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { siGraphEdges, siGraphEvidence, siGraphNodes } from "@/db/schema";
import { newId, nowIso } from "./ids";
import {
  edgeConfidence,
  type EdgeType,
  type NodeInput,
  type NodeType,
  type SourceSystem,
} from "./graph-model";

/**
 * Morgana Search Intelligence — phase 4 graph persistence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Upsert-only. Re-observing a node or an edge refreshes it and increments its
 * evidence count rather than inserting a second row, so an ingestion pass can
 * be replayed for free and two overlapping ticks converge instead of doubling
 * the graph.
 */

type GraphNodeRow = typeof siGraphNodes.$inferSelect;
type GraphEdgeRow = typeof siGraphEdges.$inferSelect;

/**
 * Insert or refresh a node, returning its id.
 *
 * The UNIQUE index is on (type, canonical value), so the same domain arriving
 * from a backlink pass and from a mention pass lands on one row — which is the
 * property that makes this a graph rather than several disjoint ones.
 */
export async function upsertNode(input: NodeInput): Promise<string | null> {
  const canonical = input.canonicalValue.trim();
  // An empty canonical value has no identity, so it cannot be a node. Dropping
  // it is right: inserting would create a bucket that every unparseable input
  // silently joins.
  if (!canonical) return null;

  const at = input.observedAt ?? nowIso();
  const id = newId("gn");
  await db
    .insert(siGraphNodes)
    .values({
      id,
      nodeType: input.nodeType,
      externalId: input.externalId ?? null,
      sourceSystem: input.sourceSystem ?? "derived",
      label: input.label.slice(0, 300),
      canonicalValue: canonical,
      metadata:
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      firstSeenAt: at,
      lastSeenAt: at,
      observationCount: 1,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [siGraphNodes.nodeType, siGraphNodes.canonicalValue],
      set: {
        lastSeenAt: at,
        observationCount: sql`${siGraphNodes.observationCount} + 1`,
        // The label may improve (an id becomes a title); the identity may not.
        label: input.label.slice(0, 300),
        updatedAt: at,
      },
    });

  const rows = await db
    .select({ id: siGraphNodes.id })
    .from(siGraphNodes)
    .where(
      and(
        eq(siGraphNodes.nodeType, input.nodeType),
        eq(siGraphNodes.canonicalValue, canonical),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

interface EdgeInput {
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: EdgeType;
  weight?: number;
  metadata?: Record<string, unknown>;
  observedAt?: string;
}

/**
 * Insert or reinforce an edge.
 *
 * Confidence is recomputed from the evidence count on every observation, so an
 * edge that keeps being seen becomes more credible on its own — and one seen
 * only once keeps a null confidence rather than a small number.
 */
export async function upsertEdge(input: EdgeInput): Promise<string | null> {
  if (!input.sourceNodeId || !input.targetNodeId) return null;
  // A self-edge carries no information and would make the walk revisit itself.
  if (input.sourceNodeId === input.targetNodeId) return null;

  const at = input.observedAt ?? nowIso();
  const id = newId("ge");
  await db
    .insert(siGraphEdges)
    .values({
      id,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      edgeType: input.edgeType,
      weight: input.weight ?? 1,
      confidence: edgeConfidence(1),
      evidenceCount: 1,
      firstSeenAt: at,
      lastSeenAt: at,
      metadata:
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [
        siGraphEdges.sourceNodeId,
        siGraphEdges.targetNodeId,
        siGraphEdges.edgeType,
      ],
      set: {
        lastSeenAt: at,
        evidenceCount: sql`${siGraphEdges.evidenceCount} + 1`,
        confidence: sql`min(0.99, 1.0 - 1.0 / (${siGraphEdges.evidenceCount} + 2))`,
        weight: input.weight ?? 1,
        updatedAt: at,
      },
    });

  const rows = await db
    .select({ id: siGraphEdges.id })
    .from(siGraphEdges)
    .where(
      and(
        eq(siGraphEdges.sourceNodeId, input.sourceNodeId),
        eq(siGraphEdges.targetNodeId, input.targetNodeId),
        eq(siGraphEdges.edgeType, input.edgeType),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

interface EvidenceInput {
  subjectType: "edge" | "campaign" | "finding";
  subjectId: string;
  evidenceType: string;
  sourceRecordId?: string | null;
  sourceSystem: SourceSystem;
  observedAt?: string;
  weight?: number;
  reason: string;
}

/** Record why we believe something. The UNIQUE key makes replays free. */
export async function recordEvidence(input: EvidenceInput): Promise<void> {
  const at = input.observedAt ?? nowIso();
  const dedupeKey = [
    input.subjectType,
    input.subjectId,
    input.evidenceType,
    input.sourceRecordId ?? "-",
    at.slice(0, 10),
  ].join("|");
  try {
    await db.insert(siGraphEvidence).values({
      id: newId("gv"),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      evidenceType: input.evidenceType,
      sourceRecordId: input.sourceRecordId ?? null,
      sourceSystem: input.sourceSystem,
      observedAt: at,
      weight: input.weight ?? 1,
      reason: input.reason.slice(0, 500),
      dedupeKey,
      createdAt: at,
    });
  } catch {
    // Already recorded for this subject/type/record/day.
  }
}

export async function evidenceFor(
  subjectType: "edge" | "campaign" | "finding",
  subjectId: string,
  limit = 50,
): Promise<(typeof siGraphEvidence.$inferSelect)[]> {
  return db
    .select()
    .from(siGraphEvidence)
    .where(
      and(
        eq(siGraphEvidence.subjectType, subjectType),
        eq(siGraphEvidence.subjectId, subjectId),
      ),
    )
    .orderBy(desc(siGraphEvidence.observedAt))
    .limit(limit);
}

// --- reads ------------------------------------------------------------------

export async function getNode(id: string): Promise<GraphNodeRow | undefined> {
  const rows = await db
    .select()
    .from(siGraphNodes)
    .where(eq(siGraphNodes.id, id))
    .limit(1);
  return rows[0];
}

export async function findNode(
  nodeType: NodeType,
  canonicalValue: string,
): Promise<GraphNodeRow | undefined> {
  const rows = await db
    .select()
    .from(siGraphNodes)
    .where(
      and(
        eq(siGraphNodes.nodeType, nodeType),
        eq(siGraphNodes.canonicalValue, canonicalValue),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function getNodes(
  ids: readonly string[],
): Promise<GraphNodeRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(siGraphNodes)
    .where(inArray(siGraphNodes.id, [...ids]));
}

export async function searchNodes(
  query: string,
  limit = 25,
): Promise<GraphNodeRow[]> {
  const term = `%${query.trim().toLowerCase()}%`;
  return db
    .select()
    .from(siGraphNodes)
    .where(
      sql`lower(${siGraphNodes.canonicalValue}) LIKE ${term} OR lower(${siGraphNodes.label}) LIKE ${term}`,
    )
    .orderBy(desc(siGraphNodes.observationCount))
    .limit(limit);
}

/**
 * Neighbours of a node, in both directions.
 *
 * Both directions on purpose: "who links to this domain" and "what does it link
 * to" are the same question to an analyst tracing a correlation, and a
 * one-directional walk would silently miss half the graph.
 */
export async function neighboursOf(
  nodeId: string,
  options: { edgeTypes?: readonly EdgeType[]; limit?: number } = {},
): Promise<
  {
    nodeId: string;
    edgeType: EdgeType;
    weight: number;
    direction: "out" | "in";
  }[]
> {
  const limit = options.limit ?? 100;
  const typeFilter = options.edgeTypes?.length
    ? inArray(siGraphEdges.edgeType, [...options.edgeTypes])
    : undefined;

  const rows = await db
    .select()
    .from(siGraphEdges)
    .where(
      typeFilter
        ? and(
            or(
              eq(siGraphEdges.sourceNodeId, nodeId),
              eq(siGraphEdges.targetNodeId, nodeId),
            ),
            typeFilter,
          )
        : or(
            eq(siGraphEdges.sourceNodeId, nodeId),
            eq(siGraphEdges.targetNodeId, nodeId),
          ),
    )
    .orderBy(desc(siGraphEdges.evidenceCount))
    .limit(limit);

  return rows.map((row) => ({
    nodeId: row.sourceNodeId === nodeId ? row.targetNodeId : row.sourceNodeId,
    edgeType: row.edgeType,
    weight: row.weight,
    direction: row.sourceNodeId === nodeId ? ("out" as const) : ("in" as const),
  }));
}

export async function edgesBetween(
  nodeIds: readonly string[],
): Promise<GraphEdgeRow[]> {
  if (nodeIds.length === 0) return [];
  const ids = [...nodeIds];
  return db
    .select()
    .from(siGraphEdges)
    .where(
      and(
        inArray(siGraphEdges.sourceNodeId, ids),
        inArray(siGraphEdges.targetNodeId, ids),
      ),
    );
}

export async function graphCounts(): Promise<{
  nodes: number;
  edges: number;
  byNodeType: Record<string, number>;
  byEdgeType: Record<string, number>;
}> {
  const [nodeTotal] = await db
    .select({ total: sql<number>`count(*)` })
    .from(siGraphNodes);
  const [edgeTotal] = await db
    .select({ total: sql<number>`count(*)` })
    .from(siGraphEdges);
  const nodeTypes = await db
    .select({ nodeType: siGraphNodes.nodeType, total: sql<number>`count(*)` })
    .from(siGraphNodes)
    .groupBy(siGraphNodes.nodeType);
  const edgeTypes = await db
    .select({ edgeType: siGraphEdges.edgeType, total: sql<number>`count(*)` })
    .from(siGraphEdges)
    .groupBy(siGraphEdges.edgeType);

  return {
    nodes: Number(nodeTotal?.total ?? 0),
    edges: Number(edgeTotal?.total ?? 0),
    byNodeType: Object.fromEntries(
      nodeTypes.map((row) => [row.nodeType, Number(row.total)]),
    ),
    byEdgeType: Object.fromEntries(
      edgeTypes.map((row) => [row.edgeType, Number(row.total)]),
    ),
  };
}
