import {
  normalizeBacklinkDomain,
  normalizeBacklinkUrl,
} from "./backlink-normalize";
import { normalizeKeyword } from "./keywords";

/**
 * Morgana Search Intelligence — phase 4 graph model.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Pure. No store, no database import — this module has to stay loadable outside
 * a Worker isolate, and the phase-3 lesson is that one store import is enough
 * to pull `cloudflare:workers` into the eager graph and make the logic
 * untestable.
 *
 * The whole design rests on one idea: **a node's identity is its canonical
 * value**, so the same domain observed as a backlink source, as a competitor
 * and as the host of a suspicious finding collapses onto one node rather than
 * three. Without that, a "correlation graph" is just three disconnected
 * subgraphs that never meet.
 */

export type NodeType =
  | "brand"
  | "competitor"
  | "domain"
  | "page"
  | "keyword"
  | "mention"
  | "article"
  | "backlink"
  | "referring_domain"
  | "telegram_channel"
  | "social_profile"
  | "campaign"
  | "finding"
  // Phase 5. Additive: a new subject kind is one enum value, which is what the
  // phase-4 note meant by the graph being the substrate later phases build on.
  | "audit_page"
  | "audit_issue"
  | "ai_query"
  | "cited_domain";

export type EdgeType =
  | "MENTIONS"
  | "RANKS_FOR"
  | "LINKS_TO"
  | "PUBLISHED"
  | "REFERS_TO"
  | "COMPETES_WITH"
  | "IMPERSONATES"
  | "ASSOCIATED_WITH"
  | "PART_OF_CAMPAIGN"
  | "TRIGGERED_FINDING"
  // Phase 5.
  | "HAS_AUDIT_ISSUE"
  | "CITES"
  | "MENTIONS_IN_AI_RESULT"
  | "REFERENCES_PAGE";

export type SourceSystem = "morgana" | "search_intelligence" | "derived";

export interface NodeInput {
  nodeType: NodeType;
  label: string;
  canonicalValue: string;
  externalId?: string | null;
  sourceSystem?: SourceSystem;
  metadata?: Record<string, unknown>;
  observedAt?: string;
}

/**
 * Canonicalise a raw value for its node type.
 *
 * Deliberately total: an unusable input becomes an empty string, which the
 * caller drops. Throwing here would let one malformed mention abort a whole
 * ingestion pass over thousands of good ones.
 */
export function canonicalise(nodeType: NodeType, raw: string): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  switch (nodeType) {
    case "domain":
    case "referring_domain":
    case "brand":
    case "competitor":
      return normalizeBacklinkDomain(value).normalized;
    case "page":
    case "article":
    case "mention":
    case "backlink":
      return normalizeBacklinkUrl(value);
    case "keyword":
      return normalizeKeyword(value);
    case "telegram_channel":
      // Handles are case-insensitive and the leading @ is decoration, so
      // `@CheckSig`, `checksig` and `t.me/checksig` are one channel.
      return value
        .toLowerCase()
        .replace(/^https?:\/\/(t\.me|telegram\.me)\//, "")
        .replace(/^@/, "")
        .replace(/\/+$/, "");
    case "social_profile":
      return value.toLowerCase().replace(/^@/, "");
    case "campaign":
    case "finding":
      return value;
    default:
      return value.toLowerCase();
  }
}

/** The node identity used by the UNIQUE index. */
export function nodeKey(nodeType: NodeType, canonicalValue: string): string {
  return `${nodeType}|${canonicalValue}`;
}

export function edgeKey(
  sourceNodeId: string,
  targetNodeId: string,
  edgeType: EdgeType,
): string {
  return `${sourceNodeId}|${targetNodeId}|${edgeType}`;
}

/**
 * Confidence for an edge, from how many independent observations support it.
 *
 * Returns null below the threshold rather than a small number: "we have seen
 * this once" is not "we are 20% sure", and rendering the second would invite an
 * analyst to treat a single stray observation as a weak fact rather than as no
 * fact at all.
 */
export function edgeConfidence(evidenceCount: number): number | null {
  if (evidenceCount < 2) return null;
  // Saturating: the tenth observation adds much less than the second.
  return Math.min(0.99, Math.round((1 - 1 / (evidenceCount + 1)) * 100) / 100);
}

// --- bounded traversal ------------------------------------------------------

export interface Adjacency {
  /** Neighbours of a node, in whichever direction the edge runs. */
  neighbours(
    nodeId: string,
  ): Promise<{ nodeId: string; edgeType: EdgeType; weight: number }[]>;
}

interface PathOptions {
  maxHops?: number;
  maxNodes?: number;
  edgeTypes?: readonly EdgeType[];
  /** Wall-clock budget. A traversal must never outlive the request. */
  timeBudgetMs?: number;
  now?: () => number;
}

interface PathResult {
  found: boolean;
  path: { nodeId: string; edgeType: EdgeType | null }[];
  hops: number;
  nodesVisited: number;
  /** Why the walk stopped, when it stopped early. */
  stoppedBy: "found" | "max_hops" | "max_nodes" | "timeout" | "exhausted";
}

const MAX_HOPS_CEILING = 4;

/**
 * Shortest path between two nodes, bounded three ways.
 *
 * Breadth-first and deterministic, with a hard ceiling of four hops. This is
 * not a graph engine and must not grow into one: in a graph where popular
 * domains have thousands of edges, an unbounded walk is a way to take the
 * Worker down, and a five-hop connection between two domains is not a finding
 * anybody would act on anyway.
 */
export async function findPath(
  adjacency: Adjacency,
  fromNodeId: string,
  toNodeId: string,
  options: PathOptions = {},
): Promise<PathResult> {
  const maxHops = Math.min(
    options.maxHops ?? MAX_HOPS_CEILING,
    MAX_HOPS_CEILING,
  );
  const maxNodes = options.maxNodes ?? 500;
  const timeBudgetMs = options.timeBudgetMs ?? 2_000;
  const now = options.now ?? (() => Date.now());
  const started = now();
  const allowed = options.edgeTypes ? new Set(options.edgeTypes) : null;

  if (fromNodeId === toNodeId) {
    return {
      found: true,
      path: [{ nodeId: fromNodeId, edgeType: null }],
      hops: 0,
      nodesVisited: 1,
      stoppedBy: "found",
    };
  }

  const cameFrom = new Map<string, { from: string; edgeType: EdgeType }>();
  const visited = new Set<string>([fromNodeId]);
  let frontier = [fromNodeId];

  for (let hop = 1; hop <= maxHops; hop += 1) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      if (now() - started > timeBudgetMs) {
        return {
          found: false,
          path: [],
          hops: hop - 1,
          nodesVisited: visited.size,
          stoppedBy: "timeout",
        };
      }
      for (const edge of await adjacency.neighbours(nodeId)) {
        if (allowed && !allowed.has(edge.edgeType)) continue;
        if (visited.has(edge.nodeId)) continue;
        visited.add(edge.nodeId);
        cameFrom.set(edge.nodeId, { from: nodeId, edgeType: edge.edgeType });

        if (edge.nodeId === toNodeId) {
          return {
            found: true,
            path: reconstruct(cameFrom, fromNodeId, toNodeId),
            hops: hop,
            nodesVisited: visited.size,
            stoppedBy: "found",
          };
        }
        if (visited.size >= maxNodes) {
          return {
            found: false,
            path: [],
            hops: hop,
            nodesVisited: visited.size,
            stoppedBy: "max_nodes",
          };
        }
        next.push(edge.nodeId);
      }
    }
    if (next.length === 0) {
      return {
        found: false,
        path: [],
        hops: hop,
        nodesVisited: visited.size,
        stoppedBy: "exhausted",
      };
    }
    frontier = next;
  }

  return {
    found: false,
    path: [],
    hops: maxHops,
    nodesVisited: visited.size,
    stoppedBy: "max_hops",
  };
}

function reconstruct(
  cameFrom: ReadonlyMap<string, { from: string; edgeType: EdgeType }>,
  fromNodeId: string,
  toNodeId: string,
): { nodeId: string; edgeType: EdgeType | null }[] {
  const reversed: { nodeId: string; edgeType: EdgeType | null }[] = [];
  let current = toNodeId;
  while (current !== fromNodeId) {
    const step = cameFrom.get(current);
    if (!step) break;
    reversed.push({ nodeId: current, edgeType: step.edgeType });
    current = step.from;
  }
  reversed.push({ nodeId: fromNodeId, edgeType: null });
  return reversed.toReversed();
}
