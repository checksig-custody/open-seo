import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { trackedKeywords } from "@/db/search-intelligence-p2.schema";
import { siKeywordVolumeSnapshots } from "@/db/search-intelligence-volume.schema";
import { newId } from "./ids";

/**
 * Morgana Search Intelligence — measured search volumes, kept as history.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Two writes, deliberately: an immutable snapshot of what was measured, and the
 * `tracked_keywords.search_volume` cell that Keyword Gap and Share of Search
 * already read. The cell is a current-value cache of the newest snapshot; the
 * snapshot is the record. Nothing here ever rewrites a snapshot.
 */

interface VolumeSnapshotWrite {
  trackedKeywordId: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  searchEngine: string;
  /** `null` = the provider did not say. `0` = the provider said zero. */
  searchVolume: number | null;
  competition: number | null;
  competitionLevel: string | null;
  costPerClickMicros: number | null;
  keywordDifficulty: number | null;
  searchIntent: string | null;
  provider: string;
  source: "dataforseo" | "fixture";
  collectedAt: string;
  collectionWindow: string;
  snapshotStatus: "complete" | "partial" | "no_data";
  snapshotStatusReason: string | null;
  jobId: string | null;
  providerResponseId: string | null;
}

/** `keyword|location|language|engine|window` — one measurement per market per window. */
function volumeDedupeKey(input: {
  trackedKeywordId: string;
  locationCode: number;
  languageCode: string;
  searchEngine: string;
  collectionWindow: string;
}): string {
  return [
    input.trackedKeywordId,
    input.locationCode,
    input.languageCode,
    input.searchEngine,
    input.collectionWindow,
  ].join("|");
}

/**
 * Store one measurement, once.
 *
 * `onConflictDoNothing` on the dedupe key rather than an upsert: a second
 * collection in the same window must not overwrite the first, because the first
 * is what the derived numbers of that window were computed from. Returns
 * whether a row was actually written, so a caller can tell a fresh measurement
 * from a repeat without a second query.
 */
export async function saveVolumeSnapshot(
  input: VolumeSnapshotWrite,
): Promise<{ id: string; created: boolean }> {
  const dedupeKey = volumeDedupeKey(input);
  const id = newId("kv");
  const inserted = await db
    .insert(siKeywordVolumeSnapshots)
    .values({ id, dedupeKey, ...input })
    .onConflictDoNothing({ target: siKeywordVolumeSnapshots.dedupeKey })
    .returning({ id: siKeywordVolumeSnapshots.id });

  if (inserted[0]) return { id: inserted[0].id, created: true };

  const existing = await db
    .select({ id: siKeywordVolumeSnapshots.id })
    .from(siKeywordVolumeSnapshots)
    .where(eq(siKeywordVolumeSnapshots.dedupeKey, dedupeKey))
    .limit(1);
  return { id: existing[0]?.id ?? id, created: false };
}

/**
 * Refresh the read model from a measurement.
 *
 * Only ever called with a volume the provider actually stated. A null is not
 * written back: overwriting a known volume with "unknown" because one later
 * call came back empty would lose a measurement that is still the best
 * available answer.
 */
export async function updateKeywordVolume(
  trackedKeywordId: string,
  searchVolume: number,
): Promise<void> {
  await db
    .update(trackedKeywords)
    .set({ searchVolume, updatedAt: new Date().toISOString() })
    .where(eq(trackedKeywords.id, trackedKeywordId));
}

/** The newest measurement per keyword, for the read surface. */
export async function latestVolumeSnapshots(limit = 100) {
  return db
    .select()
    .from(siKeywordVolumeSnapshots)
    .orderBy(desc(siKeywordVolumeSnapshots.collectedAt))
    .limit(limit);
}
