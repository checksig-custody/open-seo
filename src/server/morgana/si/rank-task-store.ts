import { and, asc, eq, inArray, lte, or, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { siRankTasks } from "@/db/schema";
import { newId, nowIso } from "./ids";

/**
 * Morgana Search Intelligence — the SERP task lifecycle.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * The row that survives between paying for a SERP and reading it. Its own file
 * because claiming is the thing that decides whether money may be spent on a
 * keyword today, and that decision deserves to be the only subject of a module.
 */

type RankTaskStatus =
  | "queued"
  | "submitting"
  | "submitted"
  | "waiting"
  | "ready"
  | "fetching"
  | "normalizing"
  | "succeeded"
  | "skipped"
  | "recovery_pending"
  | "failed";

/** Statuses meaning "a paid submission for this work is already in flight". */
const PENDING_STATUSES: RankTaskStatus[] = [
  "submitting",
  "submitted",
  "waiting",
  "ready",
  "fetching",
  "normalizing",
];

type RankTaskRow = typeof siRankTasks.$inferSelect;

interface RankTaskIdentity {
  trackedKeywordId: string;
  entityId: string;
  keyword: string;
  targetDomain: string;
  locationCode: number;
  languageCode: string;
  device: "desktop" | "mobile";
  searchEngine: string;
  collectionWindow: string;
}

/**
 * What makes two requests "the same work".
 *
 * Every dimension that changes the answer is in the key, and nothing that does
 * not. Location, language and device are here because the same keyword ranks
 * differently in each; the collection window is here because yesterday's answer
 * is not today's. Time itself is NOT here — a key derived from a timestamp
 * would make every request unique and defeat the whole point.
 *
 * THE ENTITY IS NOT HERE EITHER, and that is the point. One SERP contains every
 * competitor's position as well as ours, so a task is per KEYWORD: buying one
 * per tracked entity would pay five times for five readings of the same page.
 * The task's `entity_id` records which entity's domain drove the request, not
 * which entity the answer is for — the answer is for all of them.
 */
function rankTaskDedupeKey(identity: RankTaskIdentity): string {
  return [
    identity.trackedKeywordId,
    identity.collectionWindow,
    identity.locationCode,
    identity.languageCode,
    identity.device,
    identity.searchEngine,
  ].join("|");
}

interface ClaimResult {
  /** `claimed` — proceed to submit. `duplicate` — someone already paid. */
  outcome: "claimed" | "duplicate";
  task: RankTaskRow;
}

/**
 * Claim the right to submit one paid SERP task, or discover that someone
 * already has.
 *
 * The UNIQUE index on `dedupe_key` is the actual guard: two concurrent ticks
 * race on an INSERT and exactly one wins, which is what makes a doubled
 * scheduler tick free rather than billable. The loser reads the existing row
 * and is told `duplicate` — it must NOT submit, and it must not treat the
 * situation as an error, because the work it wanted doing is being done.
 *
 * A row in a terminal state (`succeeded`, `failed`, `skipped`) is re-claimable:
 * a keyword that failed at 09:00 should be retryable at 09:20 rather than
 * locked out for the rest of the day. Re-claiming resets the lifecycle but
 * never clears `provider_task_id`, because that id is the receipt for a call
 * that has already been billed — see `resumable`.
 */
export async function claimRankTask(
  identity: RankTaskIdentity,
  jobId: string | null,
): Promise<ClaimResult> {
  const dedupeKey = rankTaskDedupeKey(identity);
  const timestamp = nowIso();
  const id = newId("rt");
  try {
    const inserted = await db
      .insert(siRankTasks)
      .values({
        id,
        jobId,
        trackedKeywordId: identity.trackedKeywordId,
        entityId: identity.entityId,
        providerTaskId: null,
        keyword: identity.keyword,
        targetDomain: identity.targetDomain,
        locationCode: identity.locationCode,
        languageCode: identity.languageCode,
        device: identity.device,
        searchEngine: identity.searchEngine,
        collectionWindow: identity.collectionWindow,
        status: "queued",
        dedupeKey,
        attemptCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning();
    const task = inserted[0];
    if (task) return { outcome: "claimed", task };
  } catch {
    // The key exists. Whether that is a refusal depends on how the previous
    // attempt ended, which is decided below rather than assumed here.
  }

  const existing = (
    await db
      .select()
      .from(siRankTasks)
      .where(eq(siRankTasks.dedupeKey, dedupeKey))
      .limit(1)
  )[0];
  // The row must exist: the insert failed because it does.
  if (!existing) throw new Error("rank task dedupe row vanished");

  if (PENDING_STATUSES.includes(existing.status as RankTaskStatus)) {
    return { outcome: "duplicate", task: existing };
  }

  // Terminal, so a fresh attempt is allowed. Compare-and-set on the terminal
  // status so this cannot steal a task another tick has just revived.
  const revived = await db
    .update(siRankTasks)
    .set({
      status: "queued",
      jobId,
      attemptCount: sql`${siRankTasks.attemptCount} + 1`,
      errorOrigin: null,
      errorClass: null,
      errorCode: null,
      endpoint: null,
      nextCheckAt: null,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(siRankTasks.dedupeKey, dedupeKey),
        inArray(siRankTasks.status, ["succeeded", "failed", "skipped"]),
      ),
    )
    .returning();
  const task = revived[0];
  if (task) return { outcome: "claimed", task };
  // Someone revived it between the read and the write. Treat as duplicate:
  // refusing to spend is always the safe side of this race.
  return { outcome: "duplicate", task: existing };
}

/**
 * Is there already a paid task whose result we can simply collect?
 *
 * A re-claimed row keeps its `provider_task_id`, so a keyword that failed
 * during NORMALIZATION — after the SERP was bought and delivered — is fetched
 * again rather than bought again. This is the difference between a retry that
 * costs nothing and a retry that costs another SERP.
 */
export function resumable(task: RankTaskRow): boolean {
  return (
    typeof task.providerTaskId === "string" && task.providerTaskId.trim() !== ""
  );
}

export async function markSubmitting(id: string): Promise<void> {
  await db
    .update(siRankTasks)
    .set({ status: "submitting", updatedAt: nowIso() })
    .where(eq(siRankTasks.id, id));
}

/**
 * Record the provider's receipt. The single most important write in the file:
 * until it lands, a paid submission exists that nothing can collect.
 */
export async function markSubmitted(input: {
  id: string;
  providerTaskId: string;
  nextCheckAt: string;
}): Promise<void> {
  const timestamp = nowIso();
  await db
    .update(siRankTasks)
    .set({
      status: "submitted",
      providerTaskId: input.providerTaskId,
      submittedAt: timestamp,
      nextCheckAt: input.nextCheckAt,
      endpoint: "v3/serp/google/organic/task_post",
      updatedAt: timestamp,
    })
    .where(eq(siRankTasks.id, input.id));
}

/** The provider has not finished; come back after the persisted backoff. */
export async function markWaiting(input: {
  id: string;
  nextCheckAt: string;
}): Promise<void> {
  const timestamp = nowIso();
  await db
    .update(siRankTasks)
    .set({
      status: "waiting",
      lastCheckedAt: timestamp,
      nextCheckAt: input.nextCheckAt,
      attemptCount: sql`${siRankTasks.attemptCount} + 1`,
      updatedAt: timestamp,
    })
    .where(eq(siRankTasks.id, input.id));
}

export async function markStatus(
  id: string,
  status: RankTaskStatus,
): Promise<void> {
  await db
    .update(siRankTasks)
    .set({ status, updatedAt: nowIso() })
    .where(eq(siRankTasks.id, id));
}

export async function markSucceeded(input: {
  id: string;
  snapshotId: string | null;
}): Promise<void> {
  const timestamp = nowIso();
  await db
    .update(siRankTasks)
    .set({
      status: "succeeded",
      snapshotId: input.snapshotId,
      completedAt: timestamp,
      lastCheckedAt: timestamp,
      nextCheckAt: null,
      updatedAt: timestamp,
    })
    .where(eq(siRankTasks.id, input.id));
}

/**
 * Automatic collection gave up; the provider task did not.
 *
 * Running out of LOCAL attempts is a fact about this engine's polling, not
 * about DataForSEO. Recording it as `failed` with a provider origin asserted
 * something nobody had observed — and it was wrong in production: the task the
 * engine declared expired at 16:35:24Z was completed by the provider at
 * 16:37:29Z, two minutes later. A `failed` row is also unreachable, so the
 * misclassification threw away a result already paid for.
 *
 * `recovery_pending` says exactly what happened and keeps the row recoverable:
 * the receipt, the job, the attempt count and every timestamp stay, and
 * `completed_at` is deliberately NOT set, because nothing completed. Automatic
 * ticks still leave it alone — `collectableTasks` does not select it — so the
 * attempt cap keeps doing its job of not polling forever.
 */
export async function markRecoveryPending(input: {
  id: string;
  endpoint: string | null;
}): Promise<void> {
  const timestamp = nowIso();
  await db
    .update(siRankTasks)
    .set({
      status: "recovery_pending",
      errorOrigin: "collection",
      errorClass: "CollectionRetryExhausted",
      errorCode: "DATAFORSEO_COLLECTION_RETRY_EXHAUSTED",
      endpoint: input.endpoint,
      lastCheckedAt: timestamp,
      nextCheckAt: null,
      updatedAt: timestamp,
    })
    .where(eq(siRankTasks.id, input.id));
}

/** One task by id, for an explicitly requested recovery. */
export async function taskById(id: string): Promise<RankTaskRow | null> {
  const rows = await db
    .select()
    .from(siRankTasks)
    .where(eq(siRankTasks.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function markFailed(input: {
  id: string;
  origin: string;
  errorClass: string;
  errorCode: string;
  endpoint: string | null;
}): Promise<void> {
  const timestamp = nowIso();
  await db
    .update(siRankTasks)
    .set({
      status: "failed",
      errorOrigin: input.origin,
      errorClass: input.errorClass,
      errorCode: input.errorCode,
      endpoint: input.endpoint,
      completedAt: timestamp,
      lastCheckedAt: timestamp,
      nextCheckAt: null,
      updatedAt: timestamp,
    })
    .where(eq(siRankTasks.id, input.id));
}

export async function markSkipped(input: {
  id: string;
  errorCode: string;
}): Promise<void> {
  const timestamp = nowIso();
  await db
    .update(siRankTasks)
    .set({
      status: "skipped",
      errorOrigin: "collection",
      errorCode: input.errorCode,
      completedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(siRankTasks.id, input.id));
}

/**
 * Tasks whose result is due to be collected.
 *
 * Ordered by `next_check_at` so the longest-waiting is served first, and
 * bounded by the caller so one invocation cannot spend its whole subrequest
 * budget on collection. A null `next_check_at` on a submitted task means "check
 * as soon as convenient" and sorts first.
 */
export async function collectableTasks(limit: number): Promise<RankTaskRow[]> {
  const now = nowIso();
  return db
    .select()
    .from(siRankTasks)
    .where(
      and(
        inArray(siRankTasks.status, ["submitted", "waiting", "ready"]),
        or(isNull(siRankTasks.nextCheckAt), lte(siRankTasks.nextCheckAt, now)),
      ),
    )
    .orderBy(asc(siRankTasks.nextCheckAt))
    .limit(limit);
}

export async function recentTasks(limit = 50): Promise<RankTaskRow[]> {
  return db
    .select()
    .from(siRankTasks)
    .orderBy(sql`${siRankTasks.createdAt} DESC`)
    .limit(limit);
}
