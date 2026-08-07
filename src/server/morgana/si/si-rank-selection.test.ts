import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — which keywords a paid submission may buy.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P17).
 *
 * `dueKeywords` orders by priority, which is the right default and the wrong
 * policy for one authorised purchase. The watchlist holds keywords whose search
 * volume has never been measured, and three of them are `critical` — so a tick
 * bounded only by a count spends on them ahead of keywords that have a volume
 * and can therefore be weighted by anything downstream.
 *
 * On 2026-08-07 that mattered concretely: five keywords needed ranking to close
 * the coverage blocker, and the five highest-priority due keywords were not
 * those five. Naming them is what makes the purchase auditable.
 */

const keywordRows: Record<string, unknown>[] = [];

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(keywordRows),
      }),
    }),
  },
}));

// The schema barrel reaches `cloudflare:workers` through the provider module,
// which does not exist outside workerd. Only the table handles are needed here,
// and they are opaque to the code under test.
vi.mock("@/db/schema", () => ({
  keywordClusters: {},
  siRankSnapshots: {},
  trackedKeywords: { trackingEnabled: {} },
}));

const { dueKeywords } = await import("./p2-store");

const now = new Date("2026-08-07T17:45:00.000Z");
const due = "2026-08-06T13:14:37.000Z";
const notYet = "2026-08-09T00:00:00.000Z";

const keyword = (
  id: string,
  priority: string,
  searchVolume: number | null,
  nextCheckAt: string = due,
) => ({ id, keyword: id, priority, searchVolume, nextCheckAt });

beforeEach(() => {
  keywordRows.length = 0;
  keywordRows.push(
    keyword("tk_checksig", "critical", 880),
    keyword("tk_check_sig", "critical", 110),
    keyword("tk_ametrano", "critical", 110),
    // Critical, and nobody has ever measured what it is worth.
    keyword("tk_custodia_bitcoin", "critical", null),
    keyword("tk_dgi", "critical", 20),
    keyword("tk_custodia_crypto", "high", 10),
    keyword("tk_crypto_custody", "high", 10),
  );
});

describe("selecting keywords for a paid submission", () => {
  it("takes priority order when nothing is named", () => {
    // The default, unchanged: highest priority first, bounded by the limit.
    return dueKeywords(3, now).then((rows) => {
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.priority === "critical")).toBe(true);
    });
  });

  it("would otherwise spend on a keyword with no measured volume", async () => {
    // Not a bug in `dueKeywords` — a reason the caller needs to be able to say
    // what it wants. Five criticals include the one with a null volume.
    const rows = await dueKeywords(5, now);
    expect(rows.map((r) => r.id)).toContain("tk_custodia_bitcoin");
  });

  it("buys exactly the keywords it was given, and nothing else", async () => {
    const wanted = [
      "tk_checksig",
      "tk_ametrano",
      "tk_dgi",
      "tk_custodia_crypto",
      "tk_crypto_custody",
    ];
    const rows = await dueKeywords(5, now, wanted);
    expect(rows.map((r) => r.id).toSorted()).toEqual(wanted.toSorted());
    // The volumeless critical is not among them, even though it outranks two
    // of the five on priority.
    expect(rows.map((r) => r.id)).not.toContain("tk_custodia_bitcoin");
  });

  it("narrows only — a named keyword that is not due is still not bought", async () => {
    keywordRows.push(keyword("tk_later", "critical", 500, notYet));
    const rows = await dueKeywords(5, now, ["tk_later", "tk_checksig"]);
    // Naming a keyword must not become a way around the cadence, which is one
    // of the things standing between this subsystem and a repeat purchase.
    expect(rows.map((r) => r.id)).toEqual(["tk_checksig"]);
  });

  it("treats an empty list as 'no restriction', not 'nothing'", async () => {
    // A caller that sends `[]` meant to send nothing at all; reading it as "buy
    // no keywords" would silently turn a tick into a no-op.
    const rows = await dueKeywords(2, now, []);
    expect(rows).toHaveLength(2);
  });

  it("still honours the limit when more keywords are named than allowed", async () => {
    const rows = await dueKeywords(2, now, [
      "tk_checksig",
      "tk_ametrano",
      "tk_dgi",
    ]);
    expect(rows).toHaveLength(2);
  });
});
