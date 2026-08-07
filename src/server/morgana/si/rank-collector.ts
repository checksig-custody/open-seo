import { loadDataforseoSections } from "@/server/lib/dataforseo/client";
import {
  accountFor,
  readProviderCost,
  type CollectionAccounting,
} from "./collection-accounting";
import {
  classifyProviderError,
  isTransportFailure,
  type TypedFailure,
} from "./rank-errors";
import {
  normalizeRank,
  type NormalizedRank,
  type SerpItem,
} from "./rank-normalize";

/**
 * Morgana Search Intelligence — the phase 2 live SERP collector.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * A thin adapter, exactly like phase 1's: the transport, the retry policy and
 * the credential lookup already exist in `src/server/lib/dataforseo/`, and
 * `runtime-env.ts` maps `DATAFORSEO_API_KEY` onto
 * `DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY`, so this engine reaches its own
 * account and has no path to Brand Monitoring's.
 *
 * It bypasses `createDataforseoClient` for the same reason phase 1 does: that
 * factory charges an organization's usage credits through upstream billing, and
 * this deployment has no organization — it has its own ledger and its own caps.
 *
 * SUBMISSION AND COLLECTION ARE DIFFERENT OPERATIONS, and the difference is the
 * whole design. `task_post` is charged and returns a receipt. `task_get` is free
 * and may answer "not yet" many times. Conflating them would either bill twice
 * or hold a Worker invocation open across a provider queue — and losing that
 * invocation would lose the record of a purchase already made.
 */

export const TASK_POST_ENDPOINT = "v3/serp/google/organic/task_post";
export const TASK_GET_ENDPOINT = "v3/serp/google/organic/task_get/advanced";

/**
 * SERP depth.
 *
 * DataForSEO bills per page of ten, and `stop_crawl_on_match` means a page-one
 * ranking is charged as one page even at a higher depth. Ten is the minimum the
 * API accepts and the cheapest possible request; it is also enough for the
 * product's question, which is "where on page one, if at all".
 */
export const SERP_DEPTH = 10;

interface SubmitOutcome {
  providerTaskId: string;
  accounting: CollectionAccounting;
  endpoint: string;
}

/**
 * Buy one SERP. Exactly one task, deliberately.
 *
 * Upstream accepts up to 100 tasks per post and Morgana submits one, because a
 * batch is a single ledger figure covering many keywords: attributing spend per
 * keyword afterwards would be a division, not a measurement. One task, one
 * receipt, one cost.
 *
 * Throws on provider failure. It must never return a "no ranking" — a purchase
 * that failed is not a SERP without our domain in it.
 */
export async function submitRankTask(input: {
  keyword: string;
  trackedKeywordId: string;
  targetDomain: string;
  locationCode: number;
  languageCode: string;
  device: "desktop" | "mobile";
}): Promise<SubmitOutcome> {
  const sections = await loadDataforseoSections();
  const response = await sections.postRankCheckTasks({
    tasks: [
      {
        keyword: input.keyword,
        keywordId: input.trackedKeywordId,
        device: input.device,
      },
    ],
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    depth: SERP_DEPTH,
    targetDomain: input.targetDomain,
  });

  const cost = readProviderCost(response.billing);
  const endpoint = response.billing.path.join("/");
  const accounting = accountFor([{ endpointPath: endpoint, cost }], {
    metered: true,
    paidSubmission: true,
  });

  const posted = response.data[0];
  if (!posted?.taskId) {
    // DataForSEO accepted the request but created no task. The post may still
    // have been charged, so the caller records the accounting either way — but
    // there is no receipt, and without one nothing can ever collect a result.
    const error = Object.assign(new Error("task_post returned no task id"), {
      name: "DataForSEOTaskPostError",
      code: "DATAFORSEO_TASK_FAILED",
    });
    throw Object.assign(error, { accounting, endpoint });
  }

  return { providerTaskId: posted.taskId, accounting, endpoint };
}

/**
 * What one collection attempt learned.
 *
 * THE SPLIT THAT MATTERS is between `failed` and `unavailable`. Both used to be
 * `failed`, and the caller made that terminal — so a transient inability to
 * READ an answer was recorded as DataForSEO's verdict ON the task, the row
 * became invisible to `collectableTasks`, and a SERP already paid for was
 * stranded. That happened three times on 2026-08-07, and all three collected
 * successfully once asked again.
 *
 *   pending     — the provider says it is still working. Ask later.
 *   unavailable — we could not read an answer. We know nothing about the task,
 *                 the receipt is still good, and this must never be terminal.
 *   failed      — the provider judged THIS TASK and rejected it. Terminal.
 *   expired     — the provider no longer holds the task. Terminal, and distinct
 *                 because the receipt is now worthless: re-collecting can never
 *                 succeed, so only a new purchase could.
 *   completed   — a SERP was read, whether or not anything matched.
 */
type CollectOutcome =
  | { status: "pending"; accounting: CollectionAccounting }
  | {
      status: "unavailable";
      failure: TypedFailure;
      accounting: CollectionAccounting;
    }
  | {
      status: "expired";
      failure: TypedFailure;
      accounting: CollectionAccounting;
    }
  | {
      status: "failed";
      failure: TypedFailure;
      accounting: CollectionAccounting;
    }
  | {
      status: "completed";
      /** One reading of the same SERP per tracked entity, keyed by entity id. */
      ranks: Record<string, NormalizedRank>;
      /** True when the SERP was read and contained no organic results at all. */
      noResults: boolean;
      accounting: CollectionAccounting;
    };

/**
 * Has the provider stopped holding this task?
 *
 * DataForSEO keeps a completed task's result for a bounded window and then
 * discards it; asking afterwards returns "task not found". That is a different
 * fact from a task it rejected, because the RECEIPT IS NOW WORTHLESS — no
 * amount of re-collecting can succeed, and only a new purchase could. Recording
 * both as `TASK_FAILED` left `resumable()` willing to re-fetch a receipt the
 * provider no longer honours, forever.
 *
 * Deliberately a narrow, explicit list. An unrecognised code stays a plain task
 * failure: inventing an expiry from a code nobody has observed would be the
 * same guess in the other direction.
 */
const EXPIRED_TASK_STATUS_CODES: ReadonlySet<number> = new Set([
  40100, // Task Not Found
  40102, // Task Not Found (result already collected or evicted)
]);

function isExpiredTaskStatus(statusCode: number | null): boolean {
  return statusCode !== null && EXPIRED_TASK_STATUS_CODES.has(statusCode);
}

/**
 * Collect a bought SERP and turn it into a ranking.
 *
 * FREE, and accounted as such: `result_fetch` is a metering class that consumes
 * no allowance, so polling a slow task can never ration paid work. It is still
 * counted as a request, because it is one.
 *
 * "Pending" is a first-class answer, not an error. So is a SERP with no organic
 * results — the page was read, and our domain is genuinely not on it.
 */
export async function collectRankTask(input: {
  providerTaskId: string;
  entities: readonly {
    id: string;
    registrableDomain: string;
    includeSubdomains?: boolean;
  }[];
}): Promise<CollectOutcome> {
  const freeCall = {
    endpointPath: TASK_GET_ENDPOINT,
    // A free endpoint reports no cost, and that is a measured zero rather than
    // a gap: we know what task_get costs, which is nothing.
    cost: { micros: 0, status: "zero" as const },
  };
  const accounting = accountFor([freeCall], {
    metered: false,
    paidSubmission: false,
  });

  let outcome;
  try {
    const sections = await loadDataforseoSections();
    outcome = await sections.fetchQueuedSerpItems({
      taskId: input.providerTaskId,
    });
  } catch (error) {
    // A THROW MEANS WE NEVER READ AN ANSWER. `fetchQueuedSerpItems` throws when
    // the response envelope is unusable — a 5xx, a rate limit, a body that will
    // not parse — none of which is a statement about the task. Classifying this
    // as a task failure is what stranded three paid SERPs.
    const failure = classifyProviderError(error, TASK_GET_ENDPOINT);
    return {
      status: isTransportFailure(failure) ? "unavailable" : "failed",
      failure,
      accounting,
    };
  }

  if (outcome.status === "pending") return { status: "pending", accounting };

  if (outcome.status === "failed") {
    // The provider answered ABOUT THIS TASK. Its own status code is the only
    // thing that says what it decided, so it is carried and nothing else from
    // the response is.
    const expired = isExpiredTaskStatus(outcome.statusCode);
    return {
      status: expired ? "expired" : "failed",
      failure: {
        origin: "provider",
        code: expired ? "DATAFORSEO_TASK_EXPIRED" : "DATAFORSEO_TASK_FAILED",
        errorClass: "DataForSEOTaskStatus",
        message: `task reported status ${String(outcome.statusCode ?? "unknown")}`,
        endpoint: TASK_GET_ENDPOINT,
      },
      accounting,
    };
  }

  // The page is parsed once and asked a different question per entity: "where
  // are you on this SERP". That is what makes competitor tracking free once the
  // keyword's SERP has been bought.
  const items = outcome.items as readonly SerpItem[];
  const ranks: Record<string, NormalizedRank> = {};
  for (const entity of input.entities) {
    ranks[entity.id] = normalizeRank({
      items,
      registrableDomain: entity.registrableDomain,
      includeSubdomains: entity.includeSubdomains,
    });
  }
  return {
    status: "completed",
    ranks,
    noResults: outcome.noResults,
    accounting,
  };
}
