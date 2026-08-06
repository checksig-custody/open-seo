import { collectDomainOverview } from "./live-domain-collector";
import { failureSummary, logCollectionFailure } from "./collection-log";
import * as store from "./store";
import * as jobs from "./job-store";
import * as ledger from "./ledger-store";

/**
 * Morgana Search Intelligence — the phase-1 live collection step.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * Split out of `service.ts` so the orchestration there reads as a sequence of
 * decisions (is it due, is it claimed, is there a credential, is there budget)
 * and this file holds the one step that actually spends money.
 *
 * Everything upstream has already decided this call is allowed: the credential
 * exists, the feature is on, and the budget guard let it through. What is left
 * is the call, what it costs, and what happens when it fails.
 *
 * A FAILURE IS RECORDED AS A FAILURE, never as an empty snapshot. That
 * distinction is the reason this code is shaped the way it is: an empty
 * snapshot would flow into the delta computation and render as "organic traffic
 * fell to zero", which is a measurement nobody made.
 */

const DOMAIN_OVERVIEW_ENDPOINT =
  "dataforseo_labs/google/domain_rank_overview/live";

interface LiveRefreshOutcome {
  status: "created" | "reused" | "failed";
  snapshotId: string | null;
  reason: string;
  costMicros: number;
}

export async function runLiveDomainRefresh(input: {
  entity: store.SearchEntityRow;
  jobId: string;
  snapshotDate: string;
  keywordLimit: number;
  pageLimit: number;
  /** A forced refresh overwrites the day already-stored snapshot. */
  force?: boolean;
}): Promise<LiveRefreshOutcome> {
  const { entity, jobId, snapshotDate } = input;
  try {
    const collected = await collectDomainOverview({
      domain: entity.normalizedDomain,
      locationCode: entity.locationCode,
      languageCode: entity.languageCode,
      keywordLimit: input.keywordLimit,
      pageLimit: input.pageLimit,
      includeSubdomains: entity.includeSubdomains,
    });

    // LEDGER FIRST, then persistence.
    //
    // The calls have already happened and may already have been billed. If the
    // snapshot write fails after them, the money is still spent — so recording
    // usage before persisting means a persistence failure loses the RESULT,
    // never the record of what it cost. The other order loses both.
    //
    // One row per endpoint, each carrying its own provider-reported cost, so a
    // call whose cost was not reported is visible as exactly that instead of
    // being averaged into the others.
    let costMicros = 0;
    for (const call of collected.calls) {
      await ledger.recordUsage({
        day: snapshotDate,
        entityId: entity.id,
        endpointPath: call.endpointPath,
        meteringClass: "paid_submission",
        costStatus: call.cost.status,
        actualCostMicros: call.cost.micros ?? undefined,
        estimatedCostMicros: call.cost.micros ?? undefined,
      });
      costMicros += call.cost.micros ?? 0;
    }

    const result = await store.persistSnapshot({
      entity,
      snapshotDate,
      metrics: collected.metrics,
      keywords: collected.keywords,
      pages: collected.pages,
      source: "dataforseo",
      estimatedCostMicros: costMicros,
      actualCostMicros: costMicros,
      // Reaching here at all means the collection was allowed to run: either
      // no snapshot existed for today, or the caller forced one. In the second
      // case the calls are already paid for, so the fresh result replaces the
      // stale row rather than being discarded by the dedupe key.
      replaceExisting: input.force,
    });

    // A partial collection is finished as `failed`, not `succeeded`. That is
    // deliberate: `failed` is re-claimable later the same day, so the next tick
    // can try again, and the snapshot it already wrote stays available to read.
    // Marking it succeeded would freeze a knowingly incomplete result for the
    // rest of the day.
    const partial = collected.completeness === "partial";
    await jobs.finishJob(jobId, {
      status: partial ? "failed" : "succeeded",
      snapshotId: result.snapshotId,
      skipReason: partial ? "partial_result" : undefined,
      lastError: partial ? (collected.partialReason ?? null) : null,
    });
    return {
      status: partial ? "failed" : result.created ? "created" : "reused",
      snapshotId: result.snapshotId,
      reason: partial
        ? (collected.partialReason ?? "partial_result")
        : collected.completeness === "no_data"
          ? "provider_has_no_data"
          : "live",
      costMicros,
    };
  } catch (error) {
    // WHAT FAILED, not what the catch happens to sit around.
    //
    // This block covers the provider calls AND everything after them, so it
    // used to answer "provider_error" for a D1 write that failed — and ledger
    // a failed provider request against an endpoint that had succeeded. Two
    // production failures were left unexplained by exactly that, which is why
    // the classification now comes from the error itself.
    const failure = logCollectionFailure(entity.id, error);

    if (failure.origin === "provider") {
      // The provider may well have charged for the call that then failed, so
      // it is recorded as metered. Over-recording a request we know was made
      // is safer than under-recording spend we cannot see — but only for a
      // call that actually happened: a persistence failure invents no request.
      await ledger.recordUsage({
        day: snapshotDate,
        entityId: entity.id,
        endpointPath: failure.endpointPath ?? DOMAIN_OVERVIEW_ENDPOINT,
        meteringClass: "paid_submission",
        // The provider may have charged for the call that then failed, and we
        // cannot know: `not_reported` is the honest status, and it keeps the
        // failure out of the money column while still counting the request.
        costStatus: "not_reported",
        failed: true,
      });
    }

    // `failed`, not `skipped`: the job store lets a failed attempt be re-claimed
    // later the same day, which is what makes a transient provider error
    // recoverable instead of a lockout until tomorrow.
    const reason =
      failure.origin === "provider" ? "provider_error" : "collection_error";
    await jobs.finishJob(jobId, {
      status: "failed",
      skipReason: reason,
      // Class, code and endpoint only — every part sanitised at the source.
      lastError: failureSummary(failure),
    });
    return {
      status: "failed",
      snapshotId: null,
      reason,
      costMicros: 0,
    };
  }
}
