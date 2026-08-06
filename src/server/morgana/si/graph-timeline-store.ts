import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { siCorrelationCheckpoints, siTimelineEvents } from "@/db/schema";
import { newId, nowIso } from "./ids";
import type { SourceSystem } from "./graph-model";

/**
 * Morgana Search Intelligence — phase 4 timeline and ingestion checkpoints.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Split from graph-store to stay inside the 400-line module limit. Both live
 * here because they are the two derived, disposable parts of phase 4: the
 * timeline can be rebuilt from its sources and the checkpoints only record how
 * far ingestion got.
 */

export type TimelineEventRow = typeof siTimelineEvents.$inferSelect;

// --- timeline ---------------------------------------------------------------

export interface TimelineInput {
  occurredAt: string;
  eventType: TimelineEventRow["eventType"];
  entityNodeId?: string | null;
  entityLabel: string;
  summary: string;
  severity?: TimelineEventRow["severity"];
  sourceSystem: SourceSystem;
  sourceRecordId?: string | null;
  evidenceRef?: string | null;
}

/**
 * Append to the timeline.
 *
 * The dedupe key is what stops the same underlying fact appearing twice because
 * two different views reported it — a new backlink is both a backlink event and
 * a campaign signal, and the analyst should see it once.
 */
export async function appendTimelineEvents(
  inputs: readonly TimelineInput[],
): Promise<number> {
  let written = 0;
  for (const input of inputs) {
    const dedupeKey = [
      input.eventType,
      input.sourceRecordId ?? input.entityLabel,
      input.occurredAt.slice(0, 19),
    ].join("|");
    try {
      await db.insert(siTimelineEvents).values({
        id: newId("tl"),
        occurredAt: input.occurredAt,
        eventType: input.eventType,
        entityNodeId: input.entityNodeId ?? null,
        entityLabel: input.entityLabel.slice(0, 300),
        summary: input.summary.slice(0, 500),
        severity: input.severity ?? "info",
        sourceSystem: input.sourceSystem,
        sourceRecordId: input.sourceRecordId ?? null,
        evidenceRef: input.evidenceRef ?? null,
        dedupeKey,
        createdAt: nowIso(),
      });
      written += 1;
    } catch {
      // Already on the timeline.
    }
  }
  return written;
}

export async function readTimeline(options: {
  since?: string;
  eventTypes?: readonly TimelineEventRow["eventType"][];
  severities?: readonly TimelineEventRow["severity"][];
  sourceSystems?: readonly SourceSystem[];
  entityNodeId?: string;
  limit?: number;
}): Promise<TimelineEventRow[]> {
  const conditions = [];
  if (options.since)
    conditions.push(gte(siTimelineEvents.occurredAt, options.since));
  if (options.eventTypes?.length)
    conditions.push(
      inArray(siTimelineEvents.eventType, [...options.eventTypes]),
    );
  if (options.severities?.length)
    conditions.push(
      inArray(siTimelineEvents.severity, [...options.severities]),
    );
  if (options.sourceSystems?.length)
    conditions.push(
      inArray(siTimelineEvents.sourceSystem, [...options.sourceSystems]),
    );
  if (options.entityNodeId)
    conditions.push(eq(siTimelineEvents.entityNodeId, options.entityNodeId));

  return db
    .select()
    .from(siTimelineEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(siTimelineEvents.occurredAt))
    .limit(options.limit ?? 200);
}

/**
 * Drop timeline events older than the retention window.
 *
 * The one place phase 4 deletes anything. The timeline is a derived read model
 * — every event can be rebuilt from its source — so compacting it loses no
 * evidence, while letting it grow without bound would eventually make the
 * whole view unqueryable.
 */
export async function compactTimeline(olderThanIso: string): Promise<number> {
  const stale = await db
    .select({ id: siTimelineEvents.id })
    .from(siTimelineEvents)
    .where(sql`${siTimelineEvents.occurredAt} < ${olderThanIso}`)
    .limit(1000);
  if (stale.length === 0) return 0;
  await db.delete(siTimelineEvents).where(
    inArray(
      siTimelineEvents.id,
      stale.map((row) => row.id),
    ),
  );
  return stale.length;
}

// --- checkpoints ------------------------------------------------------------

/** Where each source stopped last time. The reason a tick is affordable. */
export async function getCheckpoint(sourceKey: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(siCorrelationCheckpoints)
    .where(eq(siCorrelationCheckpoints.sourceKey, sourceKey))
    .limit(1);
  return rows[0]?.cursor ?? null;
}

export async function saveCheckpoint(input: {
  sourceKey: string;
  cursor: string | null;
  status: "ok" | "partial" | "failed";
  recordsProcessed: number;
  error?: string | null;
}): Promise<void> {
  const at = nowIso();
  await db
    .insert(siCorrelationCheckpoints)
    .values({
      id: newId("cp"),
      sourceKey: input.sourceKey,
      cursor: input.cursor,
      lastRunAt: at,
      lastRunStatus: input.status,
      recordsProcessed: input.recordsProcessed,
      lastError: input.error ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: siCorrelationCheckpoints.sourceKey,
      set: {
        // A failed run must NOT advance the cursor, or the records it never
        // processed are skipped forever.
        ...(input.status === "failed" ? {} : { cursor: input.cursor }),
        lastRunAt: at,
        lastRunStatus: input.status,
        recordsProcessed: sql`${siCorrelationCheckpoints.recordsProcessed} + ${input.recordsProcessed}`,
        lastError: input.error ?? null,
        updatedAt: at,
      },
    });
}

export async function listCheckpoints(): Promise<
  (typeof siCorrelationCheckpoints.$inferSelect)[]
> {
  return db
    .select()
    .from(siCorrelationCheckpoints)
    .orderBy(siCorrelationCheckpoints.sourceKey);
}
