import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { domainRefreshJobs } from "@/db/schema";
import { newId, nowIso } from "./ids";
import type { CollectionAccounting } from "./collection-accounting";

/**
 * Morgana Search Intelligence — the refresh job lifecycle.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * Split out of store.ts when the live collector arrived: claiming is the thing
 * that decides whether money may be spent on an entity today, and it earns a
 * file where that decision is the only subject.
 */

// --- refresh jobs -----------------------------------------------------------

type JobStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

function jobDedupeKey(
  entityId: string,
  snapshotDate: string,
  trigger: "scheduled" | "manual",
): string {
  return `${entityId}|${snapshotDate}|${trigger}`;
}

/**
 * Claim a refresh job. Returns null when an equivalent job already exists —
 * which is the dedup: the UNIQUE index on `dedupe_key` means a duplicated
 * scheduler tick, a double-clicked manual refresh and a retry all collapse onto
 * one job instead of one billable call each.
 */
export async function claimJob(input: {
  entityId: string;
  snapshotDate: string;
  trigger: "scheduled" | "manual";
  requestedBy?: string | null;
  /**
   * A forced refresh may re-claim a job that already SUCCEEDED.
   *
   * Without this, `force` half-works: it bypasses the snapshot dedupe but not
   * the job dedupe, so the second forced refresh of a day returns
   * `job_already_claimed` and silently does nothing. Forcing is the explicit
   * instruction to spend again, and it has to reach the thing that spends.
   *
   * A `running` job is still never stolen, forced or not — that one is about
   * concurrency, not about permission.
   */
  force?: boolean;
}): Promise<{ id: string } | null> {
  const id = newId("rj");
  try {
    await db.insert(domainRefreshJobs).values({
      id,
      entityId: input.entityId,
      status: "running",
      trigger: input.trigger,
      requestedBy: input.requestedBy ?? null,
      dedupeKey: jobDedupeKey(
        input.entityId,
        input.snapshotDate,
        input.trigger,
      ),
      attempts: 1,
      lastError: null,
      skipReason: null,
      estimatedCostMicros: 0,
      actualCostMicros: 0,
      snapshotId: null,
      createdAt: nowIso(),
      startedAt: nowIso(),
      finishedAt: null,
    });
    return { id };
  } catch {
    // The dedupe key already exists. Whether that is a refusal depends on how
    // the previous attempt ENDED, and the distinction is the difference between
    // "this is already handled" and "this entity is locked out until tomorrow".
    //
    // `running`   -> another tick holds it. Refuse; two concurrent collections
    //                would both spend.
    // `succeeded` -> today's snapshot exists. Refuse; that is the whole point
    //                of one snapshot per entity per market per day.
    // `skipped` / `failed` -> the attempt ended without producing anything and
    //                without spending. Refusing here would mean a single
    //                transient provider error, or one bad config read, locks
    //                the entity out for the rest of the day — which is exactly
    //                what happened on the first live run, where a status
    //                mis-resolution burned the slot and the retry could not get
    //                back in.
    //
    // Re-claiming is a compare-and-set on the terminal status, so it cannot
    // steal a job from a tick that is still running.
    const reclaimed = await db
      .update(domainRefreshJobs)
      .set({
        status: "running",
        attempts: sql`${domainRefreshJobs.attempts} + 1`,
        startedAt: nowIso(),
        finishedAt: null,
        skipReason: null,
        lastError: null,
      })
      .where(
        and(
          eq(
            domainRefreshJobs.dedupeKey,
            jobDedupeKey(input.entityId, input.snapshotDate, input.trigger),
          ),
          inArray(
            domainRefreshJobs.status,
            input.force
              ? ["skipped", "failed", "succeeded"]
              : ["skipped", "failed"],
          ),
        ),
      )
      .returning({ id: domainRefreshJobs.id });
    return reclaimed[0] ?? null;
  }
}

/**
 * Finish a job, recording what its operation actually cost.
 *
 * `accounting` is the SAME object the ledger was written from — not a second
 * derivation. It used to be absent entirely, so both money columns defaulted to
 * zero and a job that had spent 0.04044 USD reported spending nothing while the
 * ledger reported the truth. A job and its ledger rows describe one operation
 * and must agree about it.
 *
 * Omitting `accounting` is still valid and still means zero, but it now means
 * an honest zero: the fixture path and the skip paths make no provider call, so
 * there is nothing to attribute. `costStatus` stays null for those, which reads
 * as "no provider cost applies" rather than "measured zero".
 */
export async function finishJob(
  id: string,
  patch: {
    status: JobStatus;
    snapshotId?: string | null;
    lastError?: string | null;
    skipReason?: string | null;
    accounting?: CollectionAccounting;
  },
): Promise<void> {
  await db
    .update(domainRefreshJobs)
    .set({
      status: patch.status,
      snapshotId: patch.snapshotId ?? null,
      // Sanitised by the caller; never a stack trace or a credential.
      lastError: patch.lastError?.slice(0, 500) ?? null,
      skipReason: patch.skipReason ?? null,
      estimatedCostMicros: patch.accounting?.estimatedCostMicros ?? 0,
      actualCostMicros: patch.accounting?.actualCostMicros ?? 0,
      costStatus: patch.accounting?.costStatus ?? null,
      finishedAt: nowIso(),
    })
    .where(eq(domainRefreshJobs.id, id));
}

export async function getJob(id: string) {
  const rows = await db
    .select()
    .from(domainRefreshJobs)
    .where(eq(domainRefreshJobs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function recentJobs(limit = 50) {
  return db
    .select()
    .from(domainRefreshJobs)
    .orderBy(desc(domainRefreshJobs.createdAt))
    .limit(limit);
}
