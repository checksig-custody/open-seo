import { isEnabled, type Phase0Config } from "../phase0-env";
import { classifyGap } from "./gap";
import { detectRankingEvents } from "./events";
import * as p2 from "./p2-store";
import * as p2an from "./p2-analytics-store";

/**
 * Morgana Search Intelligence — the state derived from an observation.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Its own module so the fixture path and the live path share it EXACTLY. They
 * differ only in when it is correct to run — fixtures produce a rank the moment
 * they are asked for, while a live submission buys a SERP that arrives a tick
 * or two later — and a copy in each would let them drift on WHAT it computes,
 * which is the part that must not vary.
 */

/**
 * Recompute the gap classification and the ranking events for one keyword.
 *
 * Extracted so the fixture path and the live path share it exactly. They differ
 * only in WHEN it is right to run — see the call sites — and a copy would let
 * them drift on WHAT it does, which is the part that must not vary.
 */
export async function recomputeDerivedState(input: {
  config: Phase0Config;
  primaryId: string;
  keyword: Awaited<ReturnType<typeof p2.dueKeywords>>[number];
  date: string;
  now: Date;
}): Promise<number> {
  const { keyword, date } = input;
  const dates = await p2.recentSnapshotDates(keyword.id, 3);
  const current = await p2.observationsFor(keyword.id, date);
  const previous = dates[1]
    ? await p2.observationsFor(keyword.id, dates[1])
    : undefined;
  const beforePrevious = dates[2]
    ? await p2.observationsFor(keyword.id, dates[2])
    : undefined;

  const gap = classifyGap({
    primaryEntityId: input.primaryId,
    current,
    previous,
    searchVolume: keyword.searchVolume,
  });
  await p2an.saveGapSnapshot({
    trackedKeywordId: keyword.id,
    snapshotDate: date,
    category: gap.category,
    primaryRank: gap.primaryRank,
    bestCompetitorRank: gap.bestCompetitorRank,
    bestCompetitorEntityId: gap.bestCompetitorEntityId,
    opportunityScore: gap.opportunityScore,
  });

  if (
    keyword.alertingEnabled &&
    isEnabled(input.config.SEARCH_INTELLIGENCE_ENABLED)
  ) {
    const events = detectRankingEvents({
      trackedKeywordId: keyword.id,
      primaryEntityId: input.primaryId,
      priority: keyword.priority,
      snapshotDate: date,
      current,
      previous,
      beforePrevious,
    });
    return (await p2an.saveEvents(events)).length;
  }
  return 0;
}
