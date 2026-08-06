import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  keywordGapSnapshots,
  rankingEvents,
  shareOfSearchSnapshots,
} from "@/db/schema";
import type { RankingEvent } from "./events";
import type { GapCategoryName } from "./gap";
import { newId, nowIso } from "./ids";

/**
 * Morgana Search Intelligence — phase 2 derived analytics storage.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Gap, share of search and ranking events are all *derived* from rank
 * observations and are recomputed as a unit, so they are split from the
 * keyword configuration store they used to share a module with.
 */
// --- gap and share snapshots ------------------------------------------------

export async function saveGapSnapshot(input: {
  trackedKeywordId: string;
  snapshotDate: string;
  category: GapCategoryName;
  primaryRank: number | null;
  bestCompetitorRank: number | null;
  bestCompetitorEntityId: string | null;
  opportunityScore: number | null;
}): Promise<void> {
  await db
    .insert(keywordGapSnapshots)
    .values({
      id: newId("kg"),
      trackedKeywordId: input.trackedKeywordId,
      snapshotDate: input.snapshotDate,
      category: input.category,
      primaryRank: input.primaryRank,
      bestCompetitorRank: input.bestCompetitorRank,
      bestCompetitorEntityId: input.bestCompetitorEntityId,
      opportunityScore: input.opportunityScore,
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [
        keywordGapSnapshots.trackedKeywordId,
        keywordGapSnapshots.snapshotDate,
      ],
      set: {
        category: input.category,
        primaryRank: input.primaryRank,
        bestCompetitorRank: input.bestCompetitorRank,
        bestCompetitorEntityId: input.bestCompetitorEntityId,
        opportunityScore: input.opportunityScore,
      },
    });
}

export async function latestGapSnapshots(snapshotDate: string) {
  return db
    .select()
    .from(keywordGapSnapshots)
    .where(eq(keywordGapSnapshots.snapshotDate, snapshotDate));
}

export async function saveShareSnapshot(input: {
  entityId: string;
  clusterId: string | null;
  snapshotDate: string;
  visibilityScore: number | null;
  share: number | null;
  status: "ok" | "insufficient_data";
  reason?: string | null;
  keywordsConsidered: number;
  keywordsCovered: number;
  ctrModelVersion: string;
}): Promise<void> {
  await db
    .insert(shareOfSearchSnapshots)
    .values({
      id: newId("ss"),
      entityId: input.entityId,
      clusterId: input.clusterId,
      snapshotDate: input.snapshotDate,
      visibilityScore: input.visibilityScore,
      share: input.share,
      status: input.status,
      reason: input.reason ?? null,
      keywordsConsidered: input.keywordsConsidered,
      keywordsCovered: input.keywordsCovered,
      ctrModelVersion: input.ctrModelVersion,
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [
        shareOfSearchSnapshots.entityId,
        shareOfSearchSnapshots.clusterId,
        shareOfSearchSnapshots.snapshotDate,
      ],
      set: {
        visibilityScore: input.visibilityScore,
        share: input.share,
        status: input.status,
        reason: input.reason ?? null,
        keywordsConsidered: input.keywordsConsidered,
        keywordsCovered: input.keywordsCovered,
        ctrModelVersion: input.ctrModelVersion,
      },
    });
}

export async function shareHistory(sinceDate: string) {
  return db
    .select()
    .from(shareOfSearchSnapshots)
    .where(gte(shareOfSearchSnapshots.snapshotDate, sinceDate))
    .orderBy(shareOfSearchSnapshots.snapshotDate);
}

// --- events -----------------------------------------------------------------

/** Persist detected events; the UNIQUE dedupe key is the cooldown. */
export async function saveEvents(
  events: readonly RankingEvent[],
): Promise<RankingEvent[]> {
  const stored: RankingEvent[] = [];
  for (const event of events) {
    try {
      await db.insert(rankingEvents).values({
        id: newId("re"),
        trackedKeywordId: event.trackedKeywordId,
        entityId: event.entityId,
        eventType: event.eventType,
        previousRank: event.previousRank,
        currentRank: event.currentRank,
        competitorEntityId: event.competitorEntityId ?? null,
        rankingUrl: event.rankingUrl ?? null,
        detectedAt: nowIso(),
        dedupeKey: event.dedupeKey,
        notifiedAt: null,
        createdAt: nowIso(),
      });
      stored.push(event);
    } catch {
      // Already announced for this keyword/entity/type/day.
    }
  }
  return stored;
}

/** Events that have not been announced yet, oldest first. */
export async function pendingEvents(limit = 50) {
  return db
    .select()
    .from(rankingEvents)
    .where(isNull(rankingEvents.notifiedAt))
    .orderBy(rankingEvents.detectedAt)
    .limit(limit);
}

/** Mark events as announced so a later tick does not repeat them. */
export async function markNotified(ids: readonly string[]): Promise<void> {
  const at = nowIso();
  for (const id of ids) {
    await db
      .update(rankingEvents)
      .set({ notifiedAt: at })
      .where(and(eq(rankingEvents.id, id), isNull(rankingEvents.notifiedAt)));
  }
}
