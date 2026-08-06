import { describe, expect, it } from "vitest";
import { normalizeRank, serpHost } from "./rank-normalize";

/**
 * Morgana Search Intelligence — what a SERP means.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Pure decisions, tested exhaustively because they are the ones that turn into
 * numbers a human will act on. The three the product cannot get wrong: absence
 * is not a position, another property is not ours, and a provider problem is
 * not an absence — the third is enforced by the collector, which never calls
 * this function without a SERP it actually read.
 */

const organic = (
  rank: number,
  domain: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "organic",
  rank_group: rank,
  rank_absolute: rank + 2,
  domain,
  url: `https://${domain}/page`,
  ...extra,
});

describe("serp host normalization", () => {
  it("reads a host from an absolute URL, a bare host and a host+path", () => {
    expect(serpHost("https://www.checksig.com/it/")).toBe("www.checksig.com");
    expect(serpHost("checksig.com")).toBe("checksig.com");
    expect(serpHost("checksig.com/it/it/")).toBe("checksig.com");
  });

  it("normalizes case, port, trailing dot and encoding", () => {
    expect(serpHost("HTTPS://WWW.CheckSig.COM:443/x")).toBe("www.checksig.com");
    expect(serpHost("checksig.com.")).toBe("checksig.com");
    expect(serpHost("https://www.checksig.com/%20a")).toBe("www.checksig.com");
  });

  it("returns null rather than guessing at an unusable value", () => {
    expect(serpHost(null)).toBeNull();
    expect(serpHost("")).toBeNull();
    expect(serpHost("   ")).toBeNull();
  });
});

describe("entity scope", () => {
  const base = { registrableDomain: "checksig.com" };

  it("accepts the apex and its www host", () => {
    expect(
      normalizeRank({ items: [organic(3, "checksig.com")], ...base }).isFound,
    ).toBe(true);
    expect(
      normalizeRank({ items: [organic(3, "www.checksig.com")], ...base })
        .isFound,
    ).toBe(true);
  });

  it("rejects an arbitrary subdomain — a different property is not ours", () => {
    // Upstream's matcher would accept this via endsWith('.checksig.com') and
    // report a position for a site the watchlist does not track.
    const result = normalizeRank({
      items: [organic(2, "blog.checksig.com")],
      ...base,
    });
    expect(result.isFound).toBe(false);
    expect(result.rankGroup).toBeNull();
  });

  it("accepts other subdomains only when the entity opted in", () => {
    const result = normalizeRank({
      items: [organic(2, "blog.checksig.com")],
      ...base,
      includeSubdomains: true,
    });
    expect(result.isFound).toBe(true);
    expect(result.rankingDomain).toBe("blog.checksig.com");
  });

  it("does not match a competitor whose URL merely mentions the brand", () => {
    const result = normalizeRank({
      items: [
        {
          ...organic(1, "competitor.it"),
          url: "https://competitor.it/checksig-recensione",
        },
        { ...organic(4, "notchecksig.com"), url: "https://notchecksig.com/x" },
      ],
      ...base,
    });
    expect(result.isFound).toBe(false);
  });
});

describe("rank semantics", () => {
  const base = { registrableDomain: "checksig.com" };

  it("records absence as null, never as a sentinel position", () => {
    const result = normalizeRank({
      items: [organic(1, "competitor.it")],
      ...base,
    });
    expect(result).toMatchObject({
      isFound: false,
      rankGroup: null,
      rankAbsolute: null,
      rankingUrl: null,
      rankingDomain: null,
      resultType: null,
    });
    // The two sentinels that must never appear.
    expect(result.rankGroup).not.toBe(101);
    expect(result.rankGroup).not.toBe(0);
  });

  it("treats a SERP with no organic results as a read answer, not an error", () => {
    const result = normalizeRank({
      items: [
        { type: "featured_snippet", rank_group: 1, domain: "checksig.com" },
      ],
      ...base,
    });
    // The feature is recorded, but a featured snippet is not a ranking.
    expect(result.isFound).toBe(false);
    expect(result.serpFeatures).toContain("featured_snippet");
  });

  it("reads the position only from an organic element", () => {
    const result = normalizeRank({
      items: [
        {
          type: "paid",
          rank_group: 1,
          domain: "checksig.com",
          url: "https://checksig.com/ad",
        },
        organic(6, "www.checksig.com"),
      ],
      ...base,
    });
    expect(result.rankGroup).toBe(6);
    expect(result.resultType).toBe("organic");
  });

  it("takes the best organic position, not payload order", () => {
    const result = normalizeRank({
      items: [organic(9, "www.checksig.com"), organic(4, "checksig.com")],
      ...base,
    });
    expect(result.rankGroup).toBe(4);
  });

  it("keeps rank_absolute distinct from rank_group", () => {
    const result = normalizeRank({
      items: [organic(3, "checksig.com")],
      ...base,
    });
    expect(result.rankGroup).toBe(3);
    expect(result.rankAbsolute).toBe(5);
  });

  it("falls back to rank_group when the provider omits rank_absolute", () => {
    const result = normalizeRank({
      items: [
        {
          type: "organic",
          rank_group: 7,
          domain: "checksig.com",
          url: "https://checksig.com/",
        },
      ],
      ...base,
    });
    expect(result.rankAbsolute).toBe(7);
  });

  it("ignores an organic result carrying no position at all", () => {
    const result = normalizeRank({
      items: [
        {
          type: "organic",
          domain: "checksig.com",
          url: "https://checksig.com/",
        },
      ],
      ...base,
    });
    expect(result.isFound).toBe(false);
  });

  it("records every SERP feature seen, for later analysis", () => {
    const result = normalizeRank({
      items: [
        { type: "people_also_ask" },
        { type: "local_pack" },
        organic(2, "checksig.com"),
      ],
      ...base,
    });
    expect(result.serpFeatures).toEqual(
      expect.arrayContaining(["people_also_ask", "local_pack", "organic"]),
    );
  });
});
