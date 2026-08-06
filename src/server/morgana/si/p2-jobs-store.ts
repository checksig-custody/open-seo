import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { phase2UsageLedger, rankingJobs } from "@/db/schema";
import { newId, nowIso } from "./ids";
import type { Priority } from "./keywords";

/**
 * Morgana Search Intelligence — phase 2 jobs and usage ledger.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Split from p2-store to stay inside the 400-line module limit; scheduling
 * and accounting change for different reasons than the keyword data does.
 */

// --- jobs and usage ---------------------------------------------------------

export async function claimJob(input: {
  jobType:
    | "rank_check"
    | "keyword_gap_refresh"
    | "share_of_search_recalculate"
    | "weekly_digest";
  trackedKeywordId?: string | null;
  priority?: Priority;
  snapshotDate: string;
}): Promise<{ id: string } | null> {
  const id = newId("rj");
  try {
    await db.insert(rankingJobs).values({
      id,
      jobType: input.jobType,
      trackedKeywordId: input.trackedKeywordId ?? null,
      priority: input.priority ?? "normal",
      status: "running",
      scheduledAt: nowIso(),
      attempts: 1,
      lastError: null,
      skipReason: null,
      estimatedCostMicros: 0,
      actualCostMicros: 0,
      dedupeKey: `${input.jobType}|${input.trackedKeywordId ?? "all"}|${input.snapshotDate}`,
      createdAt: nowIso(),
      startedAt: nowIso(),
      finishedAt: null,
    });
    return { id };
  } catch {
    return null;
  }
}

export async function finishJob(
  id: string,
  status: "succeeded" | "failed" | "skipped",
  detail: {
    lastError?: string;
    skipReason?: string;
    actualCostMicros?: number;
  } = {},
): Promise<void> {
  await db
    .update(rankingJobs)
    .set({
      status,
      lastError: detail.lastError?.slice(0, 500) ?? null,
      skipReason: detail.skipReason ?? null,
      actualCostMicros: detail.actualCostMicros ?? 0,
      finishedAt: nowIso(),
    })
    .where(eq(rankingJobs.id, id));
}

export async function recentJobs(limit = 50) {
  return db
    .select()
    .from(rankingJobs)
    .orderBy(desc(rankingJobs.createdAt))
    .limit(limit);
}

/**
 * Record phase-2 usage.
 *
 * `httpRequests` and `paidTasks` are separate because one DataForSEO
 * `task_post` can carry up to 100 keywords: counting HTTP calls understates
 * spend, counting keywords overstates it, and conflating them is exactly the
 * mistake that throttled Brand Monitoring (decision #84).
 */
export async function recordPhase2Usage(input: {
  day: string;
  jobType: string;
  httpRequests?: number;
  meteredRequests?: number;
  paidTasks?: number;
  keywordsChecked?: number;
  cacheHits?: number;
  cacheMisses?: number;
  estimatedCostMicros?: number;
  actualCostMicros?: number;
  blockedByBudget?: number;
}): Promise<void> {
  const v = {
    id: newId("p2u"),
    day: input.day,
    jobType: input.jobType,
    httpRequests: input.httpRequests ?? 0,
    meteredRequests: input.meteredRequests ?? 0,
    paidTasks: input.paidTasks ?? 0,
    keywordsChecked: input.keywordsChecked ?? 0,
    cacheHits: input.cacheHits ?? 0,
    cacheMisses: input.cacheMisses ?? 0,
    estimatedCostMicros: input.estimatedCostMicros ?? 0,
    actualCostMicros: input.actualCostMicros ?? 0,
    blockedByBudget: input.blockedByBudget ?? 0,
    updatedAt: nowIso(),
  };
  await db
    .insert(phase2UsageLedger)
    .values(v)
    .onConflictDoUpdate({
      target: [phase2UsageLedger.day, phase2UsageLedger.jobType],
      set: {
        httpRequests: sql`${phase2UsageLedger.httpRequests} + ${v.httpRequests}`,
        meteredRequests: sql`${phase2UsageLedger.meteredRequests} + ${v.meteredRequests}`,
        paidTasks: sql`${phase2UsageLedger.paidTasks} + ${v.paidTasks}`,
        keywordsChecked: sql`${phase2UsageLedger.keywordsChecked} + ${v.keywordsChecked}`,
        cacheHits: sql`${phase2UsageLedger.cacheHits} + ${v.cacheHits}`,
        cacheMisses: sql`${phase2UsageLedger.cacheMisses} + ${v.cacheMisses}`,
        estimatedCostMicros: sql`${phase2UsageLedger.estimatedCostMicros} + ${v.estimatedCostMicros}`,
        actualCostMicros: sql`${phase2UsageLedger.actualCostMicros} + ${v.actualCostMicros}`,
        blockedByBudget: sql`${phase2UsageLedger.blockedByBudget} + ${v.blockedByBudget}`,
        updatedAt: v.updatedAt,
      },
    });
}

export async function phase2Totals(prefix: string) {
  const rows = await db
    .select()
    .from(phase2UsageLedger)
    .where(sql`${phase2UsageLedger.day} LIKE ${`${prefix}%`}`);
  return rows.reduce(
    (acc, r) => ({
      httpRequests: acc.httpRequests + r.httpRequests,
      meteredRequests: acc.meteredRequests + r.meteredRequests,
      paidTasks: acc.paidTasks + r.paidTasks,
      keywordsChecked: acc.keywordsChecked + r.keywordsChecked,
      cacheHits: acc.cacheHits + r.cacheHits,
      cacheMisses: acc.cacheMisses + r.cacheMisses,
      estimatedCostMicros: acc.estimatedCostMicros + r.estimatedCostMicros,
      actualCostMicros: acc.actualCostMicros + r.actualCostMicros,
      blockedByBudget: acc.blockedByBudget + r.blockedByBudget,
    }),
    {
      httpRequests: 0,
      meteredRequests: 0,
      paidTasks: 0,
      keywordsChecked: 0,
      cacheHits: 0,
      cacheMisses: 0,
      estimatedCostMicros: 0,
      actualCostMicros: 0,
      blockedByBudget: 0,
    },
  );
}
