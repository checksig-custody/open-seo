/**
 * Morgana Search Intelligence — keyword gap and Tracked Keyword Share of Search.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Pure. Two rules govern this file:
 *  - **A domain that does not rank has a NULL position, never 101.** A sentinel
 *    becomes a real number in the next average or chart that touches it.
 *  - **Nothing opaque.** The opportunity score is volume × gap size, and Share
 *    of Search is a weighted sum divided by a total. Both are explainable to a
 *    marketer in one sentence, which is the point.
 */

export type GapCategoryName =
  | "shared"
  | "primary_only"
  | "competitor_only"
  | "missing"
  | "weak"
  | "strong"
  | "new"
  | "lost"
  | "improved"
  | "declined";

type GapCategory =
  | "shared"
  | "primary_only"
  | "competitor_only"
  | "missing"
  | "weak"
  | "strong"
  | "new"
  | "lost"
  | "improved"
  | "declined";

/** One domain's observed position for one keyword. Null means "did not rank". */
export interface Observation {
  entityId: string;
  rankGroup: number | null;
  isFound: boolean;
  rankingUrl?: string | null;
}

interface GapInput {
  primaryEntityId: string;
  current: readonly Observation[];
  previous?: readonly Observation[];
  searchVolume?: number | null;
  /** Positions below the best competitor before a keyword counts as weak. */
  weakThreshold?: number;
  /** Position change before a keyword counts as improved or declined. */
  movementThreshold?: number;
}

interface GapResult {
  category: GapCategory;
  primaryRank: number | null;
  bestCompetitorRank: number | null;
  bestCompetitorEntityId: string | null;
  /** Null when volume is unknown — never a zero standing in for "no idea". */
  opportunityScore: number | null;
  /**
   * Why the score is absent, when it is.
   *
   * A null score and a zero score look alike in a table and mean opposite
   * things — "we cannot say" versus "there is nothing to gain". The reason is
   * what lets a reader tell them apart without knowing the formula.
   */
  opportunityScoreReason: string | null;
}

/** The two score fields, computed once so they can never disagree. */
function scoreFields(
  searchVolume: number | null,
  primaryRank: number | null,
  bestCompetitorRank: number | null,
): { opportunityScore: number | null; opportunityScoreReason: string | null } {
  const { score, reason } = scoreWithReason(
    searchVolume,
    primaryRank,
    bestCompetitorRank,
  );
  return { opportunityScore: score, opportunityScoreReason: reason };
}

const rankOf = (o: Observation | undefined): number | null =>
  o && o.isFound && o.rankGroup !== null ? o.rankGroup : null;

function bestCompetitor(
  observations: readonly Observation[],
  primaryEntityId: string,
): { entityId: string; rank: number } | null {
  let best: { entityId: string; rank: number } | null = null;
  for (const o of observations) {
    if (o.entityId === primaryEntityId) continue;
    const rank = rankOf(o);
    if (rank === null) continue;
    if (!best || rank < best.rank) best = { entityId: o.entityId, rank };
  }
  return best;
}

/**
 * Classify one keyword.
 *
 * Movement categories (`new`, `lost`, `improved`, `declined`) take precedence
 * over positional ones, because a change is the more actionable fact: knowing a
 * keyword is `shared` matters less than knowing it was lost yesterday.
 */
export function classifyGap(input: GapInput): GapResult {
  const weakThreshold = input.weakThreshold ?? 10;
  const movementThreshold = input.movementThreshold ?? 10;

  const primary = input.current.find(
    (o) => o.entityId === input.primaryEntityId,
  );
  const primaryRank = rankOf(primary);
  const competitor = bestCompetitor(input.current, input.primaryEntityId);

  const base = {
    primaryRank,
    bestCompetitorRank: competitor?.rank ?? null,
    bestCompetitorEntityId: competitor?.entityId ?? null,
    ...scoreFields(
      input.searchVolume ?? null,
      primaryRank,
      competitor?.rank ?? null,
    ),
  };

  if (input.previous) {
    const previousPrimary = rankOf(
      input.previous.find((o) => o.entityId === input.primaryEntityId),
    );
    if (previousPrimary === null && primaryRank !== null) {
      return { ...base, category: "new" };
    }
    if (previousPrimary !== null && primaryRank === null) {
      return { ...base, category: "lost" };
    }
    if (previousPrimary !== null && primaryRank !== null) {
      // A smaller rank number is a better position, so a drop in the number is
      // an improvement.
      const movement = previousPrimary - primaryRank;
      if (movement >= movementThreshold)
        return { ...base, category: "improved" };
      if (-movement >= movementThreshold)
        return { ...base, category: "declined" };
    }
  }

  if (primaryRank === null && competitor === null) {
    return { ...base, category: "missing" };
  }
  if (primaryRank === null) {
    return { ...base, category: "competitor_only" };
  }
  if (competitor === null) {
    return { ...base, category: "primary_only" };
  }
  if (primaryRank < competitor.rank) {
    return { ...base, category: "strong" };
  }
  if (primaryRank - competitor.rank >= weakThreshold) {
    return { ...base, category: "weak" };
  }
  return { ...base, category: "shared" };
}

/**
 * Volume × how far behind we are. Zero when we already lead, null when volume
 * is unknown. Deliberately trivial: a number a marketer can recompute by hand
 * is a number they will trust and challenge.
 */
export function opportunityScore(
  searchVolume: number | null,
  primaryRank: number | null,
  bestCompetitorRank: number | null,
): number | null {
  return scoreWithReason(searchVolume, primaryRank, bestCompetitorRank).score;
}

/**
 * The score and, when there isn't one, the missing input.
 *
 * Every refusal names a specific absent fact rather than defaulting: an unknown
 * volume cannot be weighted, and a volume of zero has nothing to weight —
 * different reasons, both honest, neither invented.
 */
function scoreWithReason(
  searchVolume: number | null,
  primaryRank: number | null,
  bestCompetitorRank: number | null,
): { score: number | null; reason: string | null } {
  if (searchVolume === null) {
    return { score: null, reason: "search_volume_unknown" };
  }
  if (searchVolume === 0) {
    return { score: null, reason: "search_volume_zero" };
  }
  if (primaryRank === null && bestCompetitorRank === null) {
    return { score: null, reason: "no_comparable_ranking" };
  }
  return {
    score: rawOpportunityScore(searchVolume, primaryRank, bestCompetitorRank),
    reason: null,
  };
}

function rawOpportunityScore(
  searchVolume: number,
  primaryRank: number | null,
  bestCompetitorRank: number | null,
): number {
  if (bestCompetitorRank === null) return 0;
  // Not ranking at all is treated as the full addressable gap.
  const gap =
    primaryRank === null
      ? Math.max(1, 100 - bestCompetitorRank)
      : Math.max(0, primaryRank - bestCompetitorRank);
  return Math.round(searchVolume * gap);
}

// --- Tracked Keyword Share of Search ---------------------------------------

/**
 * Click-through rate by organic position.
 *
 * Versioned because changing the curve changes every historical number computed
 * with it. A stored snapshot records which version produced it, so a curve
 * change is visible rather than a silent rewrite of the past.
 */
export const CTR_MODEL_VERSION = "ctr-2026-08-v1";

const CTR_CURVE: readonly number[] = [
  0, 0.284, 0.152, 0.099, 0.071, 0.052, 0.04, 0.032, 0.026, 0.022, 0.019,
];
const CTR_TAIL = 0.01;

/** CTR for a position. Null (not ranking) contributes nothing. */
export function ctrFor(rankGroup: number | null): number {
  if (rankGroup === null || rankGroup < 1) return 0;
  if (rankGroup < CTR_CURVE.length) return CTR_CURVE[rankGroup] ?? CTR_TAIL;
  // Everything past the modelled head gets a small flat value rather than zero:
  // position 15 is worth less than position 3, but it is not worth nothing.
  return rankGroup <= 20 ? CTR_TAIL : 0;
}

interface SosKeyword {
  trackedKeywordId: string;
  searchVolume: number | null;
  clusterWeight: number;
  priorityWeight: number;
  /** One observation per domain being compared. */
  observations: readonly Observation[];
}

interface SosEntityResult {
  entityId: string;
  visibilityScore: number;
  share: number | null;
}

/**
 * Why keywords were dropped before weighting.
 *
 * Counted separately because they are different problems with different fixes:
 * `volumeUnknown` is a collection gap (nobody has measured it),
 * `volumeZero` is a watchlist decision (nobody searches it), and `noPosition`
 * is a ranking gap (we have never seen where anyone stands). A single
 * "excluded" number would hide which of the three is actually blocking the
 * answer.
 */
interface SosExclusions {
  volumeUnknown: number;
  volumeZero: number;
  noPosition: number;
}

interface SosResult {
  status: "ok" | "insufficient_data";
  reason?: string;
  ctrModelVersion: string;
  keywordsConsidered: number;
  keywordsCovered: number;
  /** Volume known and above zero: the keywords that could carry weight. */
  eligibleKeywords: number;
  excludedKeywords: number;
  exclusions: SosExclusions;
  /** Covered / eligible. Null when nothing was eligible to cover. */
  coverage: number | null;
  calculatedAt: string;
  results: SosEntityResult[];
}

/** Minimum fraction of keywords that must have a usable observation. */
const MIN_COVERAGE = 0.5;

/**
 * Tracked Keyword Share of Search.
 *
 * Distinct from phase 1's Estimated Organic Visibility Share, which divides
 * provider-estimated site traffic. This one is computed from OUR keyword basket
 * and OUR CTR curve, so the two answer different questions and must never be
 * shown under the same label.
 *
 * A keyword with unknown volume is skipped rather than assumed: weighting it as
 * 1 would let a long tail of unmeasured terms quietly dominate the result.
 */
export function computeShareOfSearch(
  keywords: readonly SosKeyword[],
  entityIds: readonly string[],
): SosResult {
  const calculatedAt = new Date().toISOString();

  // Counted before anything is filtered, so the shortfall is always
  // attributable to a specific missing input rather than to "not enough data".
  const usable = keywords.filter(
    (k) => k.searchVolume !== null && k.searchVolume > 0,
  );
  const covered = usable.filter((k) =>
    k.observations.some((o) => o.isFound && o.rankGroup !== null),
  );
  const exclusions: SosExclusions = {
    volumeUnknown: keywords.filter((k) => k.searchVolume === null).length,
    volumeZero: keywords.filter((k) => k.searchVolume === 0).length,
    noPosition: usable.length - covered.length,
  };
  const excludedKeywords =
    exclusions.volumeUnknown + exclusions.volumeZero + exclusions.noPosition;
  const coverage = usable.length === 0 ? null : covered.length / usable.length;

  const insufficient = (reason: string): SosResult => ({
    status: "insufficient_data",
    reason,
    ctrModelVersion: CTR_MODEL_VERSION,
    keywordsConsidered: keywords.length,
    keywordsCovered: covered.length,
    eligibleKeywords: usable.length,
    excludedKeywords,
    exclusions,
    coverage,
    calculatedAt,
    results: entityIds.map((entityId) => ({
      entityId,
      visibilityScore: 0,
      share: null,
    })),
  });

  if (entityIds.length === 0) return insufficient("no domains selected");
  if (keywords.length === 0) return insufficient("no tracked keywords");

  if (usable.length === 0) {
    // Distinguish "nobody has measured any volume" from "every tracked keyword
    // genuinely has none" — the first is a collection gap, the second is a
    // watchlist that needs different keywords.
    return insufficient(
      exclusions.volumeZero > 0 && exclusions.volumeUnknown === 0
        ? "every tracked keyword has a measured volume of zero"
        : "no keyword has a search volume",
    );
  }

  if ((coverage ?? 0) < MIN_COVERAGE) {
    return insufficient(
      "fewer than half of the keywords with a volume have a position",
    );
  }

  const scores = new Map(entityIds.map((id) => [id, 0]));
  for (const keyword of usable) {
    const weight =
      (keyword.searchVolume ?? 0) *
      keyword.clusterWeight *
      keyword.priorityWeight;
    for (const entityId of entityIds) {
      const observation = keyword.observations.find(
        (o) => o.entityId === entityId,
      );
      const contribution = weight * ctrFor(rankOf(observation));
      scores.set(entityId, (scores.get(entityId) ?? 0) + contribution);
    }
  }

  const total = [...scores.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return insufficient("no domain has any visible position");

  return {
    status: "ok",
    ctrModelVersion: CTR_MODEL_VERSION,
    keywordsConsidered: keywords.length,
    keywordsCovered: covered.length,
    eligibleKeywords: usable.length,
    excludedKeywords,
    exclusions,
    coverage,
    calculatedAt,
    results: entityIds.map((entityId) => {
      const score = scores.get(entityId) ?? 0;
      return { entityId, visibilityScore: score, share: score / total };
    }),
  };
}
