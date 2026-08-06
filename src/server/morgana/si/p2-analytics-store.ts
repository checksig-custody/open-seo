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
  opportunityScoreReason?: string | null;
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
      opportunityScoreReason: input.opportunityScoreReason ?? null,
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
        opportunityScoreReason: input.opportunityScoreReason ?? null,
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
  eligibleKeywords?: number;
  excludedKeywords?: number;
  /** Serialized `SosExclusions`, so a shortfall names which input is missing. */
  exclusionReasons?: string | null;
  coverage?: number | null;
  calculatedAt?: string | null;
  ctrModelVersion: string;
}): Promise<void> {
  // WHY NOT ONE UPSERT.
  //
  // The dedupe index is (entity, cluster, date), and the "all clusters" row
  // carries `cluster_id = NULL`. SQLite treats NULLs as DISTINCT in a UNIQUE
  // index, so `ON CONFLICT` never matches those rows and every recalculation
  // INSERTED another one: production held 30 rows for 5 entities on a single
  // day, and a reader taking "the" row for today could get any of them. The
  // same NULL trap the ledger hit in phase 1.
  //
  // An UPDATE that matches `IS NULL` explicitly, falling back to an INSERT when
  // it changes nothing, is the upsert SQLite will not do here.
  const values = {
    visibilityScore: input.visibilityScore,
    share: input.share,
    status: input.status,
    reason: input.reason ?? null,
    keywordsConsidered: input.keywordsConsidered,
    keywordsCovered: input.keywordsCovered,
    eligibleKeywords: input.eligibleKeywords ?? 0,
    excludedKeywords: input.excludedKeywords ?? 0,
    exclusionReasons: input.exclusionReasons ?? null,
    coverage: input.coverage ?? null,
    calculatedAt: input.calculatedAt ?? null,
    ctrModelVersion: input.ctrModelVersion,
  };

  const updated = await db
    .update(shareOfSearchSnapshots)
    .set(values)
    .where(
      and(
        eq(shareOfSearchSnapshots.entityId, input.entityId),
        input.clusterId === null
          ? isNull(shareOfSearchSnapshots.clusterId)
          : eq(shareOfSearchSnapshots.clusterId, input.clusterId),
        eq(shareOfSearchSnapshots.snapshotDate, input.snapshotDate),
      ),
    )
    .returning({ id: shareOfSearchSnapshots.id });
  if (updated.length > 0) return;

  await db.insert(shareOfSearchSnapshots).values({
    id: newId("ss"),
    entityId: input.entityId,
    clusterId: input.clusterId,
    snapshotDate: input.snapshotDate,
    ...values,
    createdAt: nowIso(),
  });
}

export async function shareHistory(sinceDate: string) {
  const rows = await db
    .select()
    .from(shareOfSearchSnapshots)
    .where(gte(shareOfSearchSnapshots.snapshotDate, sinceDate))
    .orderBy(shareOfSearchSnapshots.snapshotDate);

  // The rows written before the upsert above was fixed are still there, and
  // they are honest history — just redundant. Reading the newest per entity,
  // cluster and date means a stale duplicate can never surface as a data point,
  // without deleting anything to achieve it.
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.entityId}|${row.clusterId ?? ""}|${row.snapshotDate}`;
    const held = newest.get(key);
    if (!held || row.createdAt >= held.createdAt) newest.set(key, row);
  }
  return [...newest.values()].sort((a, b) =>
    a.snapshotDate.localeCompare(b.snapshotDate),
  );
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
