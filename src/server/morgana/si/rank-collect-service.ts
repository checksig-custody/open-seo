import * as p2 from "./p2-store";
import { collectRankTask, TASK_GET_ENDPOINT } from "./rank-collector";
import { logRankFailure, persistenceFailure } from "./rank-errors";
import { iso, recordAccounting } from "./rank-live-service";
import * as tasks from "./rank-task-store";
import { providerBlock } from "./provider-circuit";
import type { SearchEntityRow } from "./store";

/**
 * Morgana Search Intelligence — collecting SERPs that have already been bought.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Separate from `rank-live-service.ts` because the two halves answer to
 * different authorities, and that separation is the whole point:
 *
 *   submission (there)  buys a SERP        -> spend authority, budget, caps
 *   collection (here)   reads a bought one -> a credential and a receipt
 *
 * Nothing in this file can spend. The only provider call it can make is
 * `task_get` against a `provider_task_id` already stored on the row, so a
 * collection cannot create a task, cannot select a keyword and cannot reach
 * `task_post` however it is invoked.
 */

/** Backoff between checks, capped so a task cannot drift for hours. */
const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
/** After this many automatic attempts, polling stops and recovery takes over. */
const MAX_COLLECT_ATTEMPTS = 8;

interface CollectResult {
  collected: number;
  pending: number;
  /**
   * Tasks this engine stopped polling, which are waiting for a deliberate
   * recovery. Counted apart from `failed` because nothing went wrong at the
   * provider and the receipt is still good — reporting them as failures is
   * what made a paid SERP look lost.
   */
  recoveryPending: number;
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
interface OneTaskOutcome {
  /**
   * `retry_exhausted` and `expired` are separated from `failed` on purpose.
   * The first means this engine stopped asking and the receipt is still good;
   * the second means the provider no longer holds the task and the receipt is
   * worthless; only `failed` is the provider rejecting the task. Folding all
   * three into one word made a tick's counters unreadable.
   */
  status:
    | "collected"
    | "pending"
    | "retry_exhausted"
    | "expired"
    | "failed"
    | "refused";
  reason: string;
  observations: number;
}

/**
 * Fetch one bought SERP and turn it into observations.
 *
 * Shared by the scheduled sweep and by an explicitly requested recovery, so the
 * two cannot drift about what a result means, what it costs or how a failure is
 * classified. It never submits: the only provider call reachable from here is
 * `task_get` against a receipt this row already holds.
 */
async function collectOneTask(input: {
  task: Awaited<ReturnType<typeof tasks.taskById>> & object;
  entity: SearchEntityRow;
  entities: readonly SearchEntityRow[];
  day: string;
  now: Date;
  /** Automatic sweeps stop at the attempt cap; a recovery is deliberate. */
  enforceAttemptCap?: boolean;
}): Promise<OneTaskOutcome> {
  const { task, entity, now } = input;
  const providerTaskId = task.providerTaskId;
  if (!providerTaskId) {
    return {
      status: "refused",
      reason: "MISSING_PROVIDER_TASK_ID",
      observations: 0,
    };
  }

  await tasks.markStatus(task.id, "fetching");
  const outcome = await collectRankTask({
    providerTaskId,
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
    // The same job as the submission this completes. A recovery is the second
    // half of one operation, not a new one.
    jobId: task.jobId,
    endpointPath: TASK_GET_ENDPOINT,
    meteringClass: "result_fetch",
    accounting: outcome.accounting,
    failed: outcome.status === "failed",
  });

  // PENDING AND UNAVAILABLE TAKE THE SAME PATH, for the same reason: neither
  // has learned anything that could condemn the task. "The provider is still
  // working" and "we could not read the provider" are different facts about
  // different things — the second is reported with its own reason — but both
  // leave a valid receipt and a row that must stay collectable.
  if (outcome.status === "pending" || outcome.status === "unavailable") {
    const unreachable = outcome.status === "unavailable";
    if (unreachable) {
      // Logged even though it is not terminal: a run of these is how a provider
      // outage looks from here, and silence would make it indistinguishable
      // from a slow SERP.
      logRankFailure(
        { trackedKeywordId: task.trackedKeywordId, taskId: task.id },
        outcome.failure,
      );
    }
    const attempt = task.attemptCount;
    if (
      input.enforceAttemptCap !== false &&
      attempt + 1 >= MAX_COLLECT_ATTEMPTS
    ) {
      // STOP ASKING — BUT DO NOT CALL IT EXPIRED.
      //
      // Reaching the local attempt cap says this engine stopped polling. It
      // says nothing about the provider, and asserting `provider` /
      // `DATAFORSEO_TASK_EXPIRED` here was wrong in production: the task
      // abandoned at 16:35:24Z was completed by DataForSEO at 16:37:29Z. The
      // row also became unreachable, discarding a SERP already paid for.
      //
      // The receipt stays valid, so this is `recovery_pending`: recoverable by
      // explicit request, invisible to automatic ticks.
      await tasks.markRecoveryPending({
        id: task.id,
        endpoint: TASK_GET_ENDPOINT,
      });
      return {
        // Its OWN status, not `failed`. Retry exhaustion, a provider verdict
        // and a persistence error were all reported as `failed`, so a tick's
        // counters could not tell "we stopped asking" from "the provider said
        // no" — and the first is recoverable while the second is not.
        status: "retry_exhausted",
        reason: "DATAFORSEO_COLLECTION_RETRY_EXHAUSTED",
        observations: 0,
      };
    }
    // A ROW ALREADY PARKED STAYS PARKED. `markWaiting` sets `waiting` and
    // increments the attempt count, and `collectableTasks` selects `waiting` —
    // so recovering a `recovery_pending` task that is still pending used to
    // push it back into the automatic sweep, where the very next tick re-hit
    // the cap and parked it again. Each cycle burned a free `task_get` and a
    // ledger row, and defeated the whole point of the parked state.
    if (task.status !== "recovery_pending") {
      await tasks.markWaiting({
        id: task.id,
        nextCheckAt: iso(
          now,
          BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 600_000,
        ),
      });
    }
    return {
      status: "pending",
      reason: unreachable ? "provider_unreachable" : "provider_not_ready",
      observations: 0,
    };
  }

  if (outcome.status === "expired") {
    // The provider no longer holds the task, so the receipt is worthless and
    // re-collecting can never succeed. Terminal, and deliberately its own code:
    // only a new purchase could recover this keyword.
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
    return {
      status: "expired",
      reason: outcome.failure.code,
      observations: 0,
    };
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
    return {
      status: "failed",
      reason: outcome.failure.code,
      observations: 0,
    };
  }

  await tasks.markStatus(task.id, "normalizing");
  try {
    let observations = 0;
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
        providerTaskId,
        provider: "dataforseo",
        now,
      });
      // A repeated collection of the same task hits the observation dedupe
      // key and writes nothing. That is the retry being idempotent.
      if (recorded) observations += 1;
    }
    // `snapshotId` stays null, and that is not an omission. One SERP produces
    // one snapshot PER TRACKED ENTITY — five here — so a single column on the
    // task could only ever name one of them, and picking one would invent a
    // precedence that does not exist. The correlation is already stored the
    // way round that fits: every snapshot carries `provider_task_id`, so "what
    // did this task produce" is a query rather than a pointer.
    await tasks.markSucceeded({ id: task.id, snapshotId: null });
    return { status: "collected", reason: "collected", observations };
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
    return { status: "failed", reason: failure.code, observations: 0 };
  }
}

export async function collectReadyRankTasks(input: {
  entities: readonly SearchEntityRow[];
  day: string;
  limit: number;
  now?: Date;
}): Promise<CollectResult> {
  const now = input.now ?? new Date();
  const byId = new Map(input.entities.map((entity) => [entity.id, entity]));
  const result: CollectResult = {
    collected: 0,
    pending: 0,
    recoveryPending: 0,
    failed: 0,
    observations: 0,
    keywordsTouched: [],
  };

  // A `task_get` is free, so the budget authority — which is where the account
  // circuit breaker lives — is never consulted on this path. That is exactly
  // why the check has to be repeated here: a suspended account will not answer,
  // and hammering it every twenty minutes from the scheduler is the behaviour
  // `40201` exists to stop. Nothing is marked failed; the tasks stay collectable
  // for when the account is usable again, because their receipts are still good.
  const circuit = await providerBlock();
  if (circuit.blocked) return result;

  const due = await tasks.collectableTasks(input.limit);
  const touched = new Set<string>();

  for (const task of due) {
    const entity = byId.get(task.entityId);
    // NO RECEIPT, NO FETCH. `provider_task_id` is the only evidence that this
    // row corresponds to a real, paid provider task; without it there is
    // nothing to ask the provider for, and asking anyway would be inventing a
    // task id. It is also what makes a fixture row uncollectable — fixtures
    // never receive one.
    if (!task.providerTaskId) {
      await tasks.markSkipped({
        id: task.id,
        errorCode: "MISSING_PROVIDER_TASK_ID",
      });
      continue;
    }
    if (!entity) {
      // The entity was deleted or disabled after the SERP was bought. The
      // result is unattributable, which is a different fact from a failed
      // fetch, so it is named separately and no provider call is made.
      await tasks.markSkipped({ id: task.id, errorCode: "UNKNOWN_ENTITY" });
      continue;
    }

    const outcome = await collectOneTask({
      task,
      entity,
      entities: input.entities,
      day: input.day,
      now,
    });
    if (outcome.status === "collected") {
      result.collected += 1;
      result.observations += outcome.observations;
      if (outcome.observations > 0) touched.add(task.trackedKeywordId);
    }
    if (outcome.status === "pending") result.pending += 1;
    // A task this engine stopped polling is still waiting to be collected, so
    // it is counted as pending rather than failed: nothing about it went wrong
    // at the provider, and reporting it as a failure is what made an operator
    // think a paid SERP had been lost.
    if (outcome.status === "retry_exhausted") result.recoveryPending += 1;
    if (
      outcome.status === "failed" ||
      outcome.status === "expired" ||
      outcome.status === "refused"
    ) {
      result.failed += 1;
    }
  }

  result.keywordsTouched = [...touched];
  return result;
}

/**
 * Redeem one named receipt, on purpose.
 *
 * The deliberate counterpart to the attempt cap: automatic collection stops so
 * it cannot poll forever, and this is how a human collects the result anyway
 * once the provider reports the task complete. It buys nothing — one
 * `task_get`, free, against a `provider_task_id` already stored — and it cannot
 * buy anything: no keyword is selected, no job is created, and `task_post` is
 * not reachable from here.
 */
export async function recoverRankTask(input: {
  taskId: string;
  entities: readonly SearchEntityRow[];
  day: string;
  now?: Date;
}): Promise<{
  status: OneTaskOutcome["status"];
  reason: string;
  observations: number;
  trackedKeywordId: string | null;
}> {
  const now = input.now ?? new Date();
  const task = await tasks.taskById(input.taskId);
  if (!task) {
    return {
      status: "refused",
      reason: "UNKNOWN_TASK",
      observations: 0,
      trackedKeywordId: null,
    };
  }
  if (task.status === "succeeded") {
    // Already redeemed. Fetching again would be free but pointless, and a second
    // pass at persistence is a second chance to duplicate an observation.
    return {
      status: "refused",
      reason: "ALREADY_SUCCEEDED",
      observations: 0,
      trackedKeywordId: task.trackedKeywordId,
    };
  }
  if (!task.providerTaskId) {
    return {
      status: "refused",
      reason: "MISSING_PROVIDER_TASK_ID",
      observations: 0,
      trackedKeywordId: task.trackedKeywordId,
    };
  }
  const entity = input.entities.find((e) => e.id === task.entityId);
  if (!entity) {
    return {
      status: "refused",
      reason: "UNKNOWN_ENTITY",
      observations: 0,
      trackedKeywordId: task.trackedKeywordId,
    };
  }

  const outcome = await collectOneTask({
    task,
    entity,
    entities: input.entities,
    day: input.day,
    now,
    // The cap bounds AUTOMATIC polling. This call is somebody deciding to
    // collect, so a still-pending provider is reported as pending and the row
    // stays recoverable — it is not re-condemned for the same reason twice.
    enforceAttemptCap: false,
  });
  return { ...outcome, trackedKeywordId: task.trackedKeywordId };
}
