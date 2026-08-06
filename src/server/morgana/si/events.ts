import type { Observation } from "./gap";
import type { Priority as KeywordPriority } from "./keywords";

/**
 * Morgana Search Intelligence — ranking event detection.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Pure. The hard part of ranking alerts is not detecting change, it is not
 * crying wolf: SERP positions oscillate by a place or two constantly, and an
 * alerting system that reports that noise gets muted within a week and prior
 * misses the one thing that mattered.
 *
 * So: gains and entries fire immediately (they are good news and rarely
 * spurious), losses require TWO consecutive observations before they are
 * announced, and everything is deduplicated per keyword/entity/type/day.
 */

export type RankingEventType =
  | "entered_top_3"
  | "entered_top_10"
  | "left_top_10"
  | "dropped_10_plus"
  | "gained_10_plus"
  | "overtaken_by_competitor"
  | "overtook_competitors"
  | "critical_keyword_lost"
  | "share_of_search_shift";

export interface RankingEvent {
  eventType: RankingEventType;
  trackedKeywordId: string;
  entityId: string;
  previousRank: number | null;
  currentRank: number | null;
  competitorEntityId?: string | null;
  rankingUrl?: string | null;
  dedupeKey: string;
}

interface DetectInput {
  trackedKeywordId: string;
  primaryEntityId: string;
  priority: KeywordPriority;
  snapshotDate: string;
  current: readonly Observation[];
  /** The immediately preceding observation set. */
  previous?: readonly Observation[];
  /** The one before that — used to confirm a sustained loss. */
  beforePrevious?: readonly Observation[];
}

const rankOf = (
  observations: readonly Observation[] | undefined,
  entityId: string,
): number | null => {
  const o = observations?.find((x) => x.entityId === entityId);
  return o && o.isFound && o.rankGroup !== null ? o.rankGroup : null;
};

function bestCompetitorRank(
  observations: readonly Observation[] | undefined,
  primaryEntityId: string,
): { entityId: string; rank: number } | null {
  let best: { entityId: string; rank: number } | null = null;
  for (const o of observations ?? []) {
    if (o.entityId === primaryEntityId) continue;
    if (!o.isFound || o.rankGroup === null) continue;
    if (!best || o.rankGroup < best.rank) {
      best = { entityId: o.entityId, rank: o.rankGroup };
    }
  }
  return best;
}

const MOVEMENT_THRESHOLD = 10;

/**
 * Detect the alert-worthy changes for one keyword.
 *
 * Returns at most a handful of events; the caller persists them against a
 * UNIQUE dedupe key, so re-running detection on the same day is a no-op.
 */
export function detectRankingEvents(input: DetectInput): RankingEvent[] {
  const {
    trackedKeywordId,
    primaryEntityId,
    priority,
    snapshotDate,
    current,
    previous,
    beforePrevious,
  } = input;

  const now = rankOf(current, primaryEntityId);
  const prior = rankOf(previous, primaryEntityId);
  const before = rankOf(beforePrevious, primaryEntityId);
  const events: RankingEvent[] = [];

  const url =
    current.find((o) => o.entityId === primaryEntityId)?.rankingUrl ?? null;

  const push = (
    eventType: RankingEventType,
    extra: Partial<RankingEvent> = {},
  ) => {
    events.push({
      eventType,
      trackedKeywordId,
      entityId: primaryEntityId,
      previousRank: prior,
      currentRank: now,
      rankingUrl: url,
      dedupeKey: `${trackedKeywordId}|${primaryEntityId}|${eventType}|${snapshotDate}`,
      ...extra,
    });
  };

  // No prior observation: nothing is a "change" yet.
  if (previous === undefined) return events;

  // --- good news, announced immediately -----------------------------------
  if (now !== null && now <= 3 && (prior === null || prior > 3)) {
    push("entered_top_3");
  } else if (now !== null && now <= 10 && (prior === null || prior > 10)) {
    // Only when it is not already reported as a top-3 entry, so one move does
    // not produce two notifications.
    push("entered_top_10");
  }
  if (prior !== null && now !== null && prior - now >= MOVEMENT_THRESHOLD) {
    push("gained_10_plus");
  }

  for (const type of detectLosses({ now, prior, before, priority })) {
    push(type);
  }
  for (const found of detectCompetitive({
    priority,
    primaryEntityId,
    current,
    previous,
    now,
    prior,
  })) {
    push(found.type, { competitorEntityId: found.competitorEntityId });
  }

  return events;
}

/**
 * Losses, which require confirmation.
 *
 * A single bad observation is very often SERP noise. Requiring the observation
 * BEFORE the previous one to have been healthy means we announce a sustained
 * loss rather than a flicker — that is the whole anti-noise mechanism.
 */
function detectLosses(input: {
  now: number | null;
  prior: number | null;
  before: number | null;
  priority: KeywordPriority;
}): RankingEventType[] {
  const { now, prior, before, priority } = input;
  if (before === null || before > 10) return [];
  const types: RankingEventType[] = [];

  if (now === null && prior !== null) {
    types.push(
      priority === "critical" ? "critical_keyword_lost" : "left_top_10",
    );
  } else if (now !== null && now > 10 && prior !== null && prior <= 10) {
    types.push("left_top_10");
  }
  if (prior !== null && now !== null && now - prior >= MOVEMENT_THRESHOLD) {
    types.push("dropped_10_plus");
  }
  return types;
}

/**
 * Competitive position, critical keywords only.
 *
 * A competitor passing us on a long-tail term is not worth a notification, and
 * reporting it would drown out the ones that are.
 */
function detectCompetitive(input: {
  priority: KeywordPriority;
  primaryEntityId: string;
  current: readonly Observation[];
  previous: readonly Observation[] | undefined;
  now: number | null;
  prior: number | null;
}): { type: RankingEventType; competitorEntityId: string }[] {
  const { priority, primaryEntityId, current, previous, now, prior } = input;
  if (priority !== "critical") return [];

  const competitorNow = bestCompetitorRank(current, primaryEntityId);
  const competitorThen = bestCompetitorRank(previous, primaryEntityId);
  const weLedBefore =
    prior !== null && (competitorThen === null || prior < competitorThen.rank);
  const weLeadNow =
    now !== null && (competitorNow === null || now < competitorNow.rank);

  if (weLedBefore && !weLeadNow && competitorNow) {
    return [
      {
        type: "overtaken_by_competitor",
        competitorEntityId: competitorNow.entityId,
      },
    ];
  }
  if (!weLedBefore && weLeadNow && competitorThen) {
    return [
      {
        type: "overtook_competitors",
        competitorEntityId: competitorThen.entityId,
      },
    ];
  }
  return [];
}

/** Share of Search moves are announced only past a meaningful delta (§10). */
const SHARE_SHIFT_THRESHOLD = 0.03;

export function detectShareShift(input: {
  entityId: string;
  previousShare: number | null;
  currentShare: number | null;
  snapshotDate: string;
}): RankingEvent | null {
  const { entityId, previousShare, currentShare, snapshotDate } = input;
  if (previousShare === null || currentShare === null) return null;
  if (Math.abs(currentShare - previousShare) < SHARE_SHIFT_THRESHOLD)
    return null;
  return {
    eventType: "share_of_search_shift",
    trackedKeywordId: "",
    entityId,
    previousRank: null,
    currentRank: null,
    dedupeKey: `share|${entityId}|share_of_search_shift|${snapshotDate}`,
  };
}
