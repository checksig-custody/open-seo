import { type Phase0Config } from "../phase0-env";
import {
  authorizePaidOperation,
  commitReservation,
  releaseReservation,
} from "./budget-authority";
import * as ledger from "./ledger-store";
import {
  AI_MAX_OUTPUT_TOKENS,
  AI_RESPONSES_ENDPOINT,
  collectAiAnswer,
  WORST_CASE_AI_RESPONSE_MICROS,
  type AiAnswerFacts,
} from "./ai-visibility-collector";
import { logRankFailure } from "./rank-errors";

/**
 * Morgana Search Intelligence — spending money on an AI observation.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P21).
 *
 * Separate from the collector because the two answer different questions: the
 * collector knows how to read an AI answer, and this knows whether we are
 * allowed to buy one. Keeping them apart is what lets the parsing be tested
 * without a budget and the budget be reasoned about without a provider.
 *
 * THE RESERVATION IS NOT OPTIONAL HERE, AND THIS IS THE COLLECTOR THAT PROVES
 * WHY. Every other paid surface in this engine has a published per-call price:
 * a SERP `task_post` is 600 µUSD, Labs endpoints are listed, Backlinks scales
 * with a sample size we choose. `llm_responses` is the one that does NOT —
 * DataForSEO adds the model provider's own token charge and does not publish it
 * — so this is precisely the call that must not be made on a check-then-call
 * basis. Capacity is held at a worst case first, and the provider's stated
 * figure settles it afterwards.
 *
 * If that figure comes back above the worst case, `commitReservation` records
 * `ESTIMATE_EXCEEDED`, and the Budget Authority then refuses every further paid
 * operation in the subsystem until a human has looked at the cost model. That is
 * the intended behaviour for an unpublished price: the first surprise is
 * absorbed, and the second one cannot happen.
 */

export type AiLiveOutcome =
  | {
      status: "observed";
      facts: AiAnswerFacts;
      costMicros: number;
      costStatus: "reported" | "zero" | "not_reported";
      endpoint: string;
      reservationId: string;
    }
  | {
      status: "refused";
      /** A budget or configuration decision. Nothing was called or charged. */
      reason: string;
      code: string;
    }
  | {
      status: "failed";
      /** The provider was called and answered badly. It may have charged. */
      reason: string;
      code: string;
      costStatus: "reported" | "zero" | "not_reported";
    };

/**
 * Observe one query against the live provider, inside the Budget Authority.
 *
 * The caller has already decided that live mode is correct; this decides whether
 * it is affordable, and is the only path in phase 5 that can reach DataForSEO.
 */
export async function collectAiObservationLive(
  config: Phase0Config,
  input: {
    queryId: string;
    query: string;
    countryCode: string | null;
    providerConfigured: boolean;
    now?: Date;
  },
): Promise<AiLiveOutcome> {
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10);

  // ONE OBSERVATION PER QUERY PER DAY, enforced by the reservation's unique
  // idempotency key rather than by a check that a concurrent tick could race.
  // A second tick for the same query on the same day is refused as a duplicate
  // before it can reach a provider that would happily charge for it twice.
  const authorization = await authorizePaidOperation(config, {
    collector: "ai_visibility",
    operationType: "llm_responses",
    worstCaseMicros: WORST_CASE_AI_RESPONSE_MICROS,
    idempotencyKey: `ai_visibility|${input.queryId}|${day}`,
    operationId: input.queryId,
    subject: input.query.slice(0, 200),
    // The token ceiling IS the sample size this estimate assumes, exactly as a
    // row limit is for Backlinks — it is the one term of the unpublished price
    // we control. Recorded so a reservation can be audited against the
    // assumption it was priced under rather than only summed.
    subjectScope: AI_MAX_OUTPUT_TOKENS,
    providerConfigured: input.providerConfigured,
    now,
  });

  if (!authorization.allowed) {
    return {
      status: "refused",
      reason: authorization.reason,
      code: authorization.code,
    };
  }

  const outcome = await collectAiAnswer({
    query: input.query,
    countryCode: input.countryCode,
  });

  // LEDGER FIRST, as everywhere in this engine: the call has happened and may be
  // billed, so a later failure to store the observation must lose the
  // observation, never the record of the money.
  await ledger.recordUsage({
    day,
    costCentre: "ai_visibility",
    entityId: null,
    jobId: input.queryId,
    endpointPath:
      outcome.status === "completed" ? outcome.endpoint : AI_RESPONSES_ENDPOINT,
    meteringClass: "paid_submission",
    costStatus: outcome.accounting.costStatus,
    actualCostMicros:
      outcome.accounting.costStatus === "not_reported"
        ? undefined
        : outcome.accounting.actualCostMicros,
    estimatedCostMicros:
      outcome.accounting.costStatus === "not_reported"
        ? undefined
        : outcome.accounting.estimatedCostMicros,
    failed: outcome.status === "failed",
  });

  // SETTLE THE RESERVATION THE SAME WAY WHETHER THE CALL SUCCEEDED OR NOT.
  // What decides the settlement is whether the PROVIDER stated a cost, never
  // whether we liked the answer: a cost we were not told stays held and waits
  // for evidence, because releasing capacity for money that may already be
  // spent is the failure mode that produced two `reconciliation_pending` rows.
  const reported = outcome.accounting.costStatus !== "not_reported";
  await commitReservation(authorization.reservationId, {
    actualCostMicros: reported ? outcome.accounting.actualCostMicros : null,
    costStatus: outcome.accounting.costStatus,
    now,
  });

  if (outcome.status === "failed") {
    logRankFailure({ trackedKeywordId: null, taskId: null }, outcome.failure);
    return {
      status: "failed",
      reason: outcome.failure.message,
      code: outcome.failure.code,
      costStatus: outcome.accounting.costStatus,
    };
  }

  return {
    status: "observed",
    facts: outcome.facts,
    costMicros: outcome.accounting.actualCostMicros,
    costStatus: outcome.accounting.costStatus,
    endpoint: outcome.endpoint,
    reservationId: authorization.reservationId,
  };
}

/**
 * Give back capacity a caller reserved and then decided not to use.
 *
 * Exported for the one case the flow above cannot cover: a caller that
 * authorises and then aborts before calling the provider. Nothing was bought, so
 * nothing is owed, and holding the worst case would ration a day for a call that
 * never happened.
 */
export async function abandonAiReservation(
  reservationId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await releaseReservation(reservationId, reason, now);
}
