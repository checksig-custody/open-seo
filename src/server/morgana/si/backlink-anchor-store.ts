import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { siAnchorSnapshots } from "@/db/schema";
import { newId, nowIso } from "./ids";

/**
 * Morgana Search Intelligence — phase 3 anchor snapshot storage.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Split from backlink-store to stay inside the 400-line module limit. Anchors
 * are a per-day aggregate rather than a per-link record, so they have a
 * different write shape from everything else in that module.
 */

type AnchorSnapshotRow = typeof siAnchorSnapshots.$inferSelect;

interface AnchorSnapshotInput {
  entityId: string;
  snapshotDate: string;
  anchorText: string | null;
  normalizedAnchor: string;
  category: AnchorSnapshotRow["category"];
  backlinkCount: number;
  referringDomainCount: number;
  suspiciousSignal: string | null;
  firstSeenAt: string;
}

export async function saveAnchorSnapshots(
  inputs: readonly AnchorSnapshotInput[],
): Promise<number> {
  const at = nowIso();
  for (const input of inputs) {
    await db
      .insert(siAnchorSnapshots)
      .values({
        id: newId("an"),
        entityId: input.entityId,
        anchorText: input.anchorText,
        normalizedAnchor: input.normalizedAnchor,
        category: input.category,
        backlinkCount: input.backlinkCount,
        referringDomainCount: input.referringDomainCount,
        firstSeenAt: input.firstSeenAt,
        lastSeenAt: at,
        snapshotAt: at,
        snapshotDate: input.snapshotDate,
        suspiciousSignal: input.suspiciousSignal,
        createdAt: at,
      })
      .onConflictDoUpdate({
        target: [
          siAnchorSnapshots.entityId,
          siAnchorSnapshots.normalizedAnchor,
          siAnchorSnapshots.snapshotDate,
        ],
        set: {
          backlinkCount: input.backlinkCount,
          referringDomainCount: input.referringDomainCount,
          category: input.category,
          suspiciousSignal: input.suspiciousSignal,
          lastSeenAt: at,
        },
      });
  }
  return inputs.length;
}

export async function latestAnchors(
  entityId: string,
  limit = 100,
): Promise<AnchorSnapshotRow[]> {
  const latest = await db
    .select({ snapshotDate: siAnchorSnapshots.snapshotDate })
    .from(siAnchorSnapshots)
    .where(eq(siAnchorSnapshots.entityId, entityId))
    .orderBy(desc(siAnchorSnapshots.snapshotDate))
    .limit(1);
  const date = latest[0]?.snapshotDate;
  if (!date) return [];
  return db
    .select()
    .from(siAnchorSnapshots)
    .where(
      and(
        eq(siAnchorSnapshots.entityId, entityId),
        eq(siAnchorSnapshots.snapshotDate, date),
      ),
    )
    .orderBy(desc(siAnchorSnapshots.referringDomainCount))
    .limit(limit);
}
