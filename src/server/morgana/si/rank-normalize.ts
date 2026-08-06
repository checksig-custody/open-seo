import { hostInEntityScope } from "./domains";

/**
 * Morgana Search Intelligence — turning a SERP into a ranking.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Pure: no binding, no provider, no clock. Everything here is a decision about
 * what a SERP means, and those are the decisions worth testing exhaustively.
 *
 * THE THREE THINGS THIS FILE REFUSES TO DO.
 *
 * **It never invents a position for "not found".** A domain that does not rank
 * has `rank_group = null`, not 101 and not 0. A sentinel survives into averages,
 * deltas and charts as though it were a measurement — 101 is not "absent", it is
 * "ranked 101st", and nothing downstream can tell the difference afterwards.
 *
 * **It never counts a different property as ours.** `blog.checksig.com` ranking
 * is not checksig.com ranking. Upstream's matcher accepts every subdomain, which
 * is right for its product and wrong for a watchlist that tracks named
 * properties, so scope is decided here against the apex and its `www` host.
 *
 * **It never turns a provider problem into an absence.** A pending task, a
 * failed task and a malformed response are not "the domain does not rank". Only
 * a SERP that was actually read and did not contain the domain is.
 */

/** One SERP element, as much of it as a ranking decision needs. */
export interface SerpItem {
  type: string;
  rank_group?: number | null;
  rank_absolute?: number | null;
  domain?: string | null;
  url?: string | null;
}

export interface NormalizedRank {
  isFound: boolean;
  rankGroup: number | null;
  rankAbsolute: number | null;
  rankingUrl: string | null;
  rankingDomain: string | null;
  resultType: string | null;
  /** Every element type seen on the SERP, for later analysis. Not scored now. */
  serpFeatures: string[];
}

/** The element type the product's ranking number is read from. Only this one. */
const RANKING_RESULT_TYPE = "organic";

/**
 * The host of a SERP URL, normalized for comparison.
 *
 * Handles the shapes DataForSEO actually returns: absolute URLs, bare
 * `host/path`, a trailing dot on the host, an upper-case host, an explicit
 * port, and percent-encoding. Anything unparseable is not a host, and a
 * candidate we cannot identify is one we must not claim as ours.
 */
export function serpHost(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (raw === "") return null;
  const candidates = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? [raw]
    : [`https://${raw}`];
  for (const candidate of candidates) {
    try {
      // `hostname` already drops the port, lowercases, and decodes IDN.
      const host = new URL(candidate).hostname.replace(/\.$/, "");
      if (host !== "") return host;
    } catch {
      // Not a URL; fall through to null rather than guessing at a host.
    }
  }
  return null;
}

/**
 * Read a ranking for one entity out of a SERP.
 *
 * `items` must be the SERP as fetched. An empty array is a legitimate answer —
 * a SERP with no organic results — and produces "not found", because the SERP
 * WAS read. The caller is responsible for never passing an empty array to mean
 * "we could not ask".
 */
export function normalizeRank(input: {
  items: readonly SerpItem[];
  registrableDomain: string;
  includeSubdomains?: boolean;
}): NormalizedRank {
  const serpFeatures = [
    ...new Set(input.items.map((item) => item.type).filter(Boolean)),
  ];

  // Only organic elements can produce the ranking number, and the best one is
  // the one a user would call "our position" — the smallest rank_group, not the
  // first in payload order, which DataForSEO does not guarantee is sorted.
  let best: { item: SerpItem; host: string; rankGroup: number } | null = null;
  for (const item of input.items) {
    if (item.type !== RANKING_RESULT_TYPE) continue;
    const host = serpHost(item.domain) ?? serpHost(item.url);
    if (
      !host ||
      !hostInEntityScope(
        host,
        input.registrableDomain,
        input.includeSubdomains ?? false,
      )
    ) {
      continue;
    }
    // A result with no position is not a ranking. Dropping it beats storing a
    // placeholder that later reads as a real position.
    const rankGroup = item.rank_group ?? item.rank_absolute;
    if (typeof rankGroup !== "number" || !Number.isFinite(rankGroup)) continue;
    if (!best || rankGroup < best.rankGroup) best = { item, host, rankGroup };
  }

  if (!best) {
    // ABSENCE, recorded as absence. Every rank field is null; none is a number
    // that could be mistaken for a position.
    return {
      isFound: false,
      rankGroup: null,
      rankAbsolute: null,
      rankingUrl: null,
      rankingDomain: null,
      resultType: null,
      serpFeatures,
    };
  }

  const rankAbsolute = best.item.rank_absolute;
  return {
    isFound: true,
    rankGroup: best.rankGroup,
    // `rank_absolute` counts ads and SERP features and is a different number
    // from `rank_group`. Falling back to rank_group when the provider omits it
    // keeps the column populated without inventing a wider position.
    rankAbsolute:
      typeof rankAbsolute === "number" && Number.isFinite(rankAbsolute)
        ? rankAbsolute
        : best.rankGroup,
    rankingUrl: best.item.url ?? null,
    rankingDomain: best.host,
    resultType: RANKING_RESULT_TYPE,
    serpFeatures,
  };
}
