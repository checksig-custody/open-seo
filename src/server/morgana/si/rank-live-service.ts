import { type Phase0Config } from "../phase0-env";
import { accountFor, type CollectionAccounting } from "./collection-accounting";
import * as ledger from "./ledger-store";
import * as p2 from "./p2-store";
import {
  collectRankTask,
  submitRankTask,
  TASK_GET_ENDPOINT,
  TASK_POST_ENDPOINT,
} from "./rank-collector";
import {
  classifyProviderError,
  failureLine,
  logRankFailure,
  persistenceFailure,
} from "./rank-errors";
import { rankPreflight } from "./rank-preflight";
import * as tasks from "./rank-task-store";
import type { SearchEntityRow } from "./store";

/**
 * Morgana Search Intelligence — driving the phase 2 SERP task lifecycle.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Two operations that never merge into one:
 *
 *   submitDueRankTask  — pays for a SERP, stores the receipt, returns.
 *   collectReadyRankTasks — collects receipts that are due, for free.
 *
 * Nothing here waits on the provider. A tick submits what it may afford and
 * collects what is ready; the next tick continues. That is what makes a queued
 * SERP survive a deploy, a timeout or a subrequest ceiling — the state is a row,
 * not a promise.
 */

/**
 * The most a single Google Organic task_post could cost, in micro-USD.
 *
 * Used as the budget headroom test, deliberately above the standard-queue price
 * of one ten-result page. A cap tested against an average is not a cap: the
 * provider states its charge only in the response, so before the call the only
 * safe question is "if this costs the most it plausibly could, are we still
 * inside the limit".
 */
export const WORST_CASE_SUBMISSION_MICROS = 3_000;

/** How long to wait before first asking whether a queued SERP is ready. */
const FIRST_CHECK_DELAY_MS = 60_000;
/** Backoff between subsequent checks, capped so a task cannot drift for hours. */
const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
/** After this many collection attempts a task is declared expired. */
const MAX_COLLECT_ATTEMPTS = 8;

const iso = (base: Date, deltaMs: number) =>
  new Date(base.getTime() + deltaMs).toISOString();

/** Ledger a call under the shared accounting model, correlated to the job. */
async function recordAccounting(input: {
  day: string;
  entityId: string;
  jobId: string | null;
  endpointPath: string;
  meteringClass: "paid_submission" | "result_fetch";
  accounting: CollectionAccounting;
  failed?: boolean;
}): Promise<void> {
  await ledger.recordUsage({
    day: input.day,
    entityId: input.entityId,
    jobId: input.jobId,
    endpointPath: input.endpointPath,
    meteringClass: input.meteringClass,
    costStatus: input.accounting.costStatus,
    actualCostMicros:
      input.accounting.costStatus === "not_reported"
        ? undefined
        : input.accounting.actualCostMicros,
    estimatedCostMicros:
      input.accounting.costStatus === "not_reported"
        ? undefined
        : input.accounting.estimatedCostMicros,
    failed: input.failed ?? false,
  });
}

interface SubmitResult {
  status: "submitted" | "duplicate" | "refused" | "failed";
  taskId: string | null;
  providerTaskId: string | null;
  reason: string;
  accounting: CollectionAccounting;
}

const NOTHING = accountFor([], { metered: false, paidSubmission: false });

/**
 * Submit one keyword/entity pair for collection, if everything permits it.
 *
 * The order matters and is the safety property: pre-flight decides whether
 * spending is allowed at all, THEN the dedupe claim decides whether this
 * particular work is already paid for, and only then does money move. A claim
 * before a pre-flight would leave rows behind for work that was never
 * authorised; a submission before a claim would double-charge a doubled tick.
 */
export async function submitDueRankTask(input: {
  config: Phase0Config;
  providerStatus: "not_configured" | "fixture" | "live";
  entity: SearchEntityRow;
  keyword: {
    id: string;
    keyword: string;
    locationCode: number;
    languageCode: string;
  };
  jobId: string | null;
  day: string;
  dailySpentMicros: number;
  monthlySpentMicros: number;
  now?: Date;
}): Promise<SubmitResult> {
  const now = input.now ?? new Date();

  const preflight = rankPreflight({
    config: input.config,
    providerStatus: input.providerStatus,
    dailySpentMicros: input.dailySpentMicros,
    monthlySpentMicros: input.monthlySpentMicros,
    worstCaseCostMicros: WORST_CASE_SUBMISSION_MICROS,
  });
  if (!preflight.ok) {
    // LIVE_RANK_PREFLIGHT_FAILED: no submission, no fixture, no cost, no
    // snapshot, and no task row either — nothing happened.
    logRankFailure(
      { trackedKeywordId: input.keyword.id, taskId: null },
      preflight.failure,
    );
    return {
      status: "refused",
      taskId: null,
      providerTaskId: null,
      reason: `LIVE_RANK_PREFLIGHT_FAILED:${preflight.reason}`,
      accounting: NOTHING,
    };
  }

  const identity = {
    trackedKeywordId: input.keyword.id,
    entityId: input.entity.id,
    keyword: input.keyword.keyword,
    targetDomain: input.entity.normalizedDomain,
    locationCode: input.keyword.locationCode,
    languageCode: input.keyword.languageCode,
    device: "desktop" as const,
    searchEngine: "google",
    collectionWindow: input.day,
  };
  const claim = await tasks.claimRankTask(identity, input.jobId);
  if (claim.outcome === "duplicate") {
    // Someone already bought this SERP. Not an error, and above all not a
    // second purchase: the existing task will be collected on a later tick.
    return {
      status: "duplicate",
      taskId: claim.task.id,
      providerTaskId: claim.task.providerTaskId,
      reason: "DUPLICATE_PENDING_TASK",
      accounting: NOTHING,
    };
  }

  // A revived task that still holds a receipt has ALREADY been paid for. Its
  // result is collectable, so buying it again would be paying twice for one
  // SERP. This is the difference between a free retry and an expensive one.
  if (tasks.resumable(claim.task)) {
    await tasks.markStatus(claim.task.id, "submitted");
    return {
      status: "duplicate",
      taskId: claim.task.id,
      providerTaskId: claim.task.providerTaskId,
      reason: "already_submitted_resumable",
      accounting: NOTHING,
    };
  }

  await tasks.markSubmitting(claim.task.id);
  try {
    const submitted = await submitRankTask({
      keyword: identity.keyword,
      trackedKeywordId: identity.trackedKeywordId,
      targetDomain: identity.targetDomain,
      locationCode: identity.locationCode,
      languageCode: identity.languageCode,
      device: identity.device,
    });

    // LEDGER BEFORE THE RECEIPT, as in phase 1: the call has happened and is
    // billed, so a failure to store the receipt must lose the receipt, never
    // the record of the money.
    await recordAccounting({
      day: input.day,
      entityId: input.entity.id,
      jobId: input.jobId,
      endpointPath: submitted.endpoint,
      meteringClass: "paid_submission",
      accounting: submitted.accounting,
    });
    await tasks.markSubmitted({
      id: claim.task.id,
      providerTaskId: submitted.providerTaskId,
      nextCheckAt: iso(now, FIRST_CHECK_DELAY_MS),
    });

    return {
      status: "submitted",
      taskId: claim.task.id,
      providerTaskId: submitted.providerTaskId,
      reason: "submitted",
      accounting: submitted.accounting,
    };
  } catch (error) {
    const failure = classifyProviderError(error, TASK_POST_ENDPOINT);
    // The post may have been charged before it failed, and we cannot see
    // whether it was. One request is counted with its cost NOT reported, which
    // keeps it out of the money column while still recording that we asked.
    const accounting = accountFor(
      [
        {
          endpointPath: TASK_POST_ENDPOINT,
          cost: { micros: null, status: "not_reported" },
        },
      ],
      { metered: true, paidSubmission: true },
    );
    await recordAccounting({
      day: input.day,
      entityId: input.entity.id,
      jobId: input.jobId,
      endpointPath: TASK_POST_ENDPOINT,
      meteringClass: "paid_submission",
      accounting,
      failed: true,
    });
    await tasks.markFailed({
      id: claim.task.id,
      origin: failure.origin,
      errorClass: failure.errorClass,
      errorCode: failure.code,
      endpoint: failure.endpoint,
    });
    logRankFailure(
      { trackedKeywordId: input.keyword.id, taskId: claim.task.id },
      failure,
    );
    return {
      status: "failed",
      taskId: claim.task.id,
      providerTaskId: null,
      reason: failureLine(failure),
      accounting,
    };
  }
}

interface CollectResult {
  collected: number;
  pending: number;
  failed: number;
  observations: number;
  keywordsTouched: string[];
}

/**
 * Collect every task whose result is due, bounded.
 *
 * Free calls, so the budget does not gate them — but they are still counted,
 * and a task that has been asked too many times is declared expired rather than
 * polled forever.
 */
export async function collectReadyRankTasks(input: {
  entities: readonly SearchEntityRow[];
  day: string;
  limit: number;
  now?: Date;
}): Promise<CollectResult> {
  const now = input.now ?? new Date();
  const byId = new Map(input.entities.map((entity) => [entity.id, entity]));
  const due = await tasks.collectableTasks(input.limit);
  const result: CollectResult = {
    collected: 0,
    pending: 0,
    failed: 0,
    observations: 0,
    keywordsTouched: [],
  };
  const touched = new Set<string>();

  for (const task of due) {
    const entity = byId.get(task.entityId);
    if (!entity || !task.providerTaskId) {
      await tasks.markSkipped({ id: task.id, errorCode: "UNCLASSIFIED" });
      continue;
    }

    await tasks.markStatus(task.id, "fetching");
    const outcome = await collectRankTask({
      providerTaskId: task.providerTaskId,
      // Fetched once. The SERP is the same page for every entity, so it is read
      // once and interpreted per entity below.
      entities: input.entities.map((e) => ({
        id: e.id,
        registrableDomain: e.normalizedDomain,
        includeSubdomains: e.includeSubdomains,
      })),
    });
    await recordAccounting({
      day: input.day,
      entityId: entity.id,
      jobId: task.jobId,
      endpointPath: TASK_GET_ENDPOINT,
      meteringClass: "result_fetch",
      accounting: outcome.accounting,
      failed: outcome.status === "failed",
    });

    if (outcome.status === "pending") {
      const attempt = task.attemptCount;
      if (attempt + 1 >= MAX_COLLECT_ATTEMPTS) {
        // Give up asking. The SERP was paid for and never delivered, which is a
        // provider fact worth naming rather than a silent absence.
        await tasks.markFailed({
          id: task.id,
          origin: "provider",
          errorClass: "DataForSEOTaskStatus",
          errorCode: "DATAFORSEO_TASK_EXPIRED",
          endpoint: TASK_GET_ENDPOINT,
        });
        result.failed += 1;
        continue;
      }
      await tasks.markWaiting({
        id: task.id,
        nextCheckAt: iso(
          now,
          BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 600_000,
        ),
      });
      result.pending += 1;
      continue;
    }

    if (outcome.status === "failed") {
      await tasks.markFailed({
        id: task.id,
        origin: outcome.failure.origin,
        errorClass: outcome.failure.errorClass,
        errorCode: outcome.failure.code,
        endpoint: outcome.failure.endpoint,
      });
      logRankFailure(
        { trackedKeywordId: task.trackedKeywordId, taskId: task.id },
        outcome.failure,
      );
      result.failed += 1;
      continue;
    }

    await tasks.markStatus(task.id, "normalizing");
    try {
      // ONE SERP, one observation per tracked entity. Every competitor's
      // position comes from the same page, which is why this costs one task.
      for (const [entityId, rank] of Object.entries(outcome.ranks)) {
        const recorded = await p2.recordRank({
          trackedKeywordId: task.trackedKeywordId,
          entityId,
          locationCode: task.locationCode,
          languageCode: task.languageCode,
          rankGroup: rank.rankGroup,
          rankAbsolute: rank.rankAbsolute,
          rankingUrl: rank.rankingUrl,
          rankingDomain: rank.rankingDomain,
          resultType: rank.resultType,
          // The SERP was read. "Not found" here is a measurement, so the
          // observation is complete — `partial` is reserved for an answer the
          // provider could not fully give, which is not this.
          snapshotStatus: "complete",
          providerTaskId: task.providerTaskId,
          provider: "dataforseo",
          now,
        });
        // A repeated collection of the same task hits the observation dedupe
        // key and writes nothing. That is the retry being idempotent.
        if (recorded) {
          result.observations += 1;
          touched.add(task.trackedKeywordId);
        }
      }
      await tasks.markSucceeded({ id: task.id, snapshotId: null });
      result.collected += 1;
    } catch (error) {
      // The SERP was bought and delivered; only our own write failed. Its
      // receipt stays on the row, so the retry is a free re-fetch.
      const failure = persistenceFailure(error, TASK_GET_ENDPOINT);
      await tasks.markFailed({
        id: task.id,
        origin: failure.origin,
        errorClass: failure.errorClass,
        errorCode: failure.code,
        endpoint: failure.endpoint,
      });
      logRankFailure(
        { trackedKeywordId: task.trackedKeywordId, taskId: task.id },
        failure,
      );
      result.failed += 1;
    }
  }

  result.keywordsTouched = [...touched];
  return result;
}
