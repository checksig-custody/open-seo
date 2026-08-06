import { badRequest, envelope, json, num, str } from "./http";
import * as graph from "./graph-store";
import * as timeline from "./graph-timeline-store";
import { findPath, type EdgeType } from "./graph-model";
import type { SiRequestContext } from "./router";

/**
 * Morgana Search Intelligence — phase 4 routes.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Every read is bounded. The graph is the one surface here where an unbounded
 * query is genuinely dangerous: a popular domain can have thousands of edges,
 * and returning them all would take down the isolate and the browser together.
 */

const EDGE_TYPES = [
  "MENTIONS",
  "RANKS_FOR",
  "LINKS_TO",
  "PUBLISHED",
  "REFERS_TO",
  "COMPETES_WITH",
  "IMPERSONATES",
  "ASSOCIATED_WITH",
  "PART_OF_CAMPAIGN",
  "TRIGGERED_FINDING",
] as const;

function parseEdgeTypes(raw: string | null): EdgeType[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is EdgeType =>
      (EDGE_TYPES as readonly string[]).includes(value),
    );
  return parsed.length > 0 ? parsed : undefined;
}

async function dispatchGraphReads(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, url, config, providerStatus } = ctx;
  const method = request.method;

  if (route === "graph/overview" && method === "GET") {
    const counts = await graph.graphCounts();
    const checkpoints = await timeline.listCheckpoints();
    return json(
      envelope(config, { ...counts, checkpoints }, { providerStatus }),
    );
  }

  if (route === "graph/search" && method === "GET") {
    const query = str(url.searchParams.get("q")) ?? "";
    if (query.length < 2)
      return badRequest("query_too_short", "q must be at least 2 characters");
    const nodes = await graph.searchNodes(query, 25);
    return json(envelope(config, { nodes }, { providerStatus }));
  }

  {
    const match = /^graph\/neighbors\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      // Hard cap regardless of what the caller asks for: the browser cannot
      // usefully render more, and the isolate should not have to build more.
      const limit = Math.min(
        200,
        num(Number(url.searchParams.get("limit"))) ?? 100,
      );
      const edgeTypes = parseEdgeTypes(url.searchParams.get("edgeTypes"));
      const centre = await graph.getNode(match[1]);
      if (!centre) return json({ error: "node not found" }, 404);

      const neighbours = await graph.neighboursOf(centre.id, {
        edgeTypes,
        limit,
      });
      const nodes = await graph.getNodes(
        neighbours.map((neighbour) => neighbour.nodeId),
      );
      const edges = await graph.edgesBetween([
        centre.id,
        ...nodes.map((node) => node.id),
      ]);
      return json(
        envelope(
          config,
          { centre, nodes, edges, truncated: neighbours.length >= limit },
          { providerStatus },
        ),
      );
    }
  }

  if (route === "graph/path" && method === "GET") {
    const from = str(url.searchParams.get("from"));
    const to = str(url.searchParams.get("to"));
    if (!from || !to)
      return badRequest("from_to_required", "from and to are required");
    const edgeTypes = parseEdgeTypes(url.searchParams.get("edgeTypes"));
    const result = await findPath(
      {
        neighbours: (nodeId) =>
          graph.neighboursOf(nodeId, { edgeTypes, limit: 100 }),
      },
      from,
      to,
      { maxHops: num(Number(url.searchParams.get("maxHops"))) ?? 4, edgeTypes },
    );
    const nodes = await graph.getNodes(result.path.map((step) => step.nodeId));
    return json(envelope(config, { ...result, nodes }, { providerStatus }));
  }

  if (route === "graph/timeline" && method === "GET") {
    const days = Math.min(365, num(Number(url.searchParams.get("days"))) ?? 30);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const events = await timeline.readTimeline({
      since,
      eventTypes: parseCsv(url.searchParams.get("eventTypes"), EVENT_TYPES),
      severities: parseCsv(url.searchParams.get("severities"), SEVERITIES),
      entityNodeId: str(url.searchParams.get("entityNodeId")),
      limit: Math.min(500, num(Number(url.searchParams.get("limit"))) ?? 200),
    });
    return json(envelope(config, { days, events }, { providerStatus }));
  }

  return null;
}

const EVENT_TYPES = [
  "mention",
  "ranking_change",
  "keyword_new",
  "keyword_lost",
  "backlink_new",
  "backlink_lost",
  "campaign_event",
  "finding",
  "sentiment_change",
  "competitor_event",
] as const;

const SEVERITIES = ["info", "notice", "warning", "critical"] as const;

/**
 * Parse a CSV filter against a known vocabulary.
 *
 * Unrecognised values are dropped rather than passed through: an unfiltered
 * value would reach the store as a literal it can never match, which reads to
 * the caller as "the filter did nothing" rather than "that filter is invalid".
 */
function parseCsv<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T[] | undefined {
  if (!raw) return undefined;
  const vocabulary = new Set<string>(allowed);
  const parsed = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is T => vocabulary.has(value));
  return parsed.length > 0 ? parsed : undefined;
}

import {
  dispatchCorrelationOperations,
  dispatchCorrelationReads,
} from "./p4-correlation-router";

export async function dispatchPhase4(
  ctx: SiRequestContext,
): Promise<Response | null> {
  return (
    (await dispatchGraphReads(ctx)) ??
    (await dispatchCorrelationReads(ctx)) ??
    (await dispatchCorrelationOperations(ctx))
  );
}
