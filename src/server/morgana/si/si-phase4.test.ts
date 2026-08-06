import { describe, expect, it } from "vitest";
import {
  canonicalise,
  edgeConfidence,
  edgeKey,
  findPath,
  nodeKey,
} from "./graph-model";
import type { Adjacency, EdgeType } from "./graph-model";

/** Phase-4 graph model and correlation logic. Pure — no store, no isolate. */

describe("node identity", () => {
  it("collapses the written forms of one domain onto a single node", () => {
    // The whole graph depends on this: the same domain seen as a backlink
    // source, a competitor and a finding host must be one node, not three.
    const forms = [
      "Example.com",
      "www.example.com",
      "https://example.com/path",
      "example.com.",
    ];
    const keys = new Set(
      forms.map((form) => nodeKey("domain", canonicalise("domain", form))),
    );
    expect(keys.size).toBe(1);
  });

  it("collapses the written forms of one telegram channel", () => {
    const forms = [
      "@CheckSig",
      "checksig",
      "https://t.me/checksig",
      "https://t.me/checksig/",
    ];
    const keys = new Set(
      forms.map((form) => canonicalise("telegram_channel", form)),
    );
    expect(keys).toEqual(new Set(["checksig"]));
  });

  it("keeps different node types apart even with the same value", () => {
    // A domain and a competitor may share a canonical value but are different
    // things; merging them would make every competitor its own referring domain.
    expect(nodeKey("domain", "example.com")).not.toBe(
      nodeKey("competitor", "example.com"),
    );
  });

  it("returns an empty identity for unusable input rather than throwing", () => {
    for (const bad of ["", "   ", "://"]) {
      expect(() => canonicalise("domain", bad)).not.toThrow();
    }
    expect(canonicalise("keyword", "   ")).toBe("");
  });

  it("makes edge identity direction-sensitive and type-sensitive", () => {
    expect(edgeKey("a", "b", "LINKS_TO")).not.toBe(
      edgeKey("b", "a", "LINKS_TO"),
    );
    expect(edgeKey("a", "b", "LINKS_TO")).not.toBe(
      edgeKey("a", "b", "MENTIONS"),
    );
  });
});

describe("edge confidence", () => {
  it("states no confidence at all from a single observation", () => {
    // "Seen once" is not "20% sure": a number there would invite an analyst to
    // treat a stray observation as a weak fact rather than as no fact.
    expect(edgeConfidence(1)).toBeNull();
    expect(edgeConfidence(0)).toBeNull();
  });

  it("rises with corroboration and saturates", () => {
    const two = edgeConfidence(2) ?? 0;
    const ten = edgeConfidence(10) ?? 0;
    expect(two).toBeGreaterThan(0);
    expect(ten).toBeGreaterThan(two);
    expect(ten).toBeLessThan(1);
  });
});

describe("bounded path search", () => {
  const graph: Record<
    string,
    { nodeId: string; edgeType: EdgeType; weight: number }[]
  > = {
    a: [{ nodeId: "b", edgeType: "LINKS_TO", weight: 1 }],
    b: [{ nodeId: "c", edgeType: "MENTIONS", weight: 1 }],
    c: [{ nodeId: "d", edgeType: "LINKS_TO", weight: 1 }],
    d: [{ nodeId: "e", edgeType: "LINKS_TO", weight: 1 }],
    e: [{ nodeId: "f", edgeType: "LINKS_TO", weight: 1 }],
  };
  const adjacency: Adjacency = {
    neighbours: (id) => Promise.resolve(graph[id] ?? []),
  };

  it("finds a short path and reports the edges taken", async () => {
    const result = await findPath(adjacency, "a", "c");
    expect(result.found).toBe(true);
    expect(result.hops).toBe(2);
    expect(result.path.map((step) => step.nodeId)).toEqual(["a", "b", "c"]);
    expect(result.path[1]?.edgeType).toBe("LINKS_TO");
  });

  it("refuses to look further than four hops", async () => {
    // `f` is five hops away. A five-hop connection between two domains is not a
    // finding anybody would act on, and an unbounded walk is a way to take the
    // Worker down.
    const result = await findPath(adjacency, "a", "f");
    expect(result.found).toBe(false);
    expect(result.stoppedBy).toBe("max_hops");
  });

  it("clamps a caller asking for more hops than the ceiling", async () => {
    const result = await findPath(adjacency, "a", "f", { maxHops: 99 });
    expect(result.found).toBe(false);
    expect(result.hops).toBeLessThanOrEqual(4);
  });

  it("stops on the node budget", async () => {
    const wide: Adjacency = {
      neighbours: (id) =>
        Promise.resolve(
          id === "a"
            ? Array.from({ length: 50 }, (_, i) => ({
                nodeId: `n${String(i)}`,
                edgeType: "LINKS_TO" as const,
                weight: 1,
              }))
            : [],
        ),
    };
    const result = await findPath(wide, "a", "unreachable", { maxNodes: 10 });
    expect(result.stoppedBy).toBe("max_nodes");
  });

  it("stops on the time budget rather than outliving the request", async () => {
    let clock = 0;
    const slow: Adjacency = {
      neighbours: () => {
        clock += 1000;
        return Promise.resolve([
          {
            nodeId: `n${String(clock)}`,
            edgeType: "LINKS_TO" as const,
            weight: 1,
          },
        ]);
      },
    };
    const result = await findPath(slow, "a", "z", {
      timeBudgetMs: 100,
      now: () => clock,
    });
    expect(result.stoppedBy).toBe("timeout");
  });

  it("honours an edge-type filter", async () => {
    const result = await findPath(adjacency, "a", "c", {
      edgeTypes: ["LINKS_TO"],
    });
    // b→c is a MENTIONS edge, so the filtered walk cannot reach c.
    expect(result.found).toBe(false);
  });

  it("returns a trivial path for a node to itself", async () => {
    const result = await findPath(adjacency, "a", "a");
    expect(result.found).toBe(true);
    expect(result.hops).toBe(0);
  });
});
