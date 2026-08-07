import { type Phase0Config } from "../phase0-env";
import { accountFor, type CollectionAccounting } from "./collection-accounting";
import * as ledger from "./ledger-store";
import {
  SERP_DEPTH,
  submitRankTask,
  TASK_POST_ENDPOINT,
} from "./rank-collector";
import { authorizePaidOperation, commitReservation } from "./budget-authority";
import {
  classifyProviderError,
  failureLine,
  logRankFailure,
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

export const iso = (base: Date, deltaMs: number) =>
  new Date(base.getTime() + deltaMs).toISOString();

/** Ledger a call under the shared accounting model, correlated to the job. */
export async function recordAccounting(input: {
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

  // RESERVE, THEN SPEND. The pre-flight above compares the ledger against the
  // cap, which is a check and not a guard: two ticks reading the same remainder
  // both proceed, and the overrun is discovered afterwards. That is exactly the
  // 2026-08-06 incident the budget authority exists to prevent, and until now
  // only Backlinks actually reserved — the SERP path still merely looked.
  //
  // Placed after the duplicate and resumable checks on purpose: neither of
  // those spends anything, so neither should hold capacity. The dedupe key is
  // the idempotency key, because it already identifies exactly one purchase —
  // this keyword, this collection window, this market and device.
  const decision = await authorizePaidOperation(input.config, {
    collector: "phase2",
    operationType: "serp_task_post",
    worstCaseMicros: WORST_CASE_SUBMISSION_MICROS,
    idempotencyKey: `serp|${tasks.rankTaskDedupeKey(identity)}`,
    subject: identity.keyword,
    subjectScope: SERP_DEPTH,
    jobId: input.jobId,
    operationId: claim.task.id,
    providerConfigured: input.providerStatus !== "not_configured",
    now,
  });
  if (!decision.allowed) {
    await tasks.markSkipped({
      id: claim.task.id,
      errorCode: decision.code,
      errorOrigin: "budget",
    });
    return {
      status: "refused",
      taskId: claim.task.id,
      providerTaskId: null,
      reason: `LIVE_RANK_NOT_AUTHORIZED:${decision.code}`,
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
    // The ledger now holds the money, so the reservation stops holding capacity
    // for it. A cost the provider did not report keeps holding it instead —
    // `commitReservation` decides that, not this call site.
    await commitReservation(decision.reservationId, {
      actualCostMicros: submitted.accounting.actualCostMicros,
      costStatus: submitted.accounting.costStatus,
      now,
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
    // The post may have been charged before it failed and we cannot see whether
    // it was, so the cost is `not_reported` — which makes this reservation stay
    // `reconciliation_pending` and KEEP holding its worst case. Releasing here
    // would hand back capacity that may already be spent.
    await commitReservation(decision.reservationId, {
      actualCostMicros: null,
      costStatus: "not_reported",
      now,
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
