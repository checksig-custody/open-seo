import { loadDataforseoSections } from "@/server/lib/dataforseo/client";
import {
  accountFor,
  readProviderCost,
  type CollectionAccounting,
} from "./collection-accounting";
import { classifyProviderError, type TypedFailure } from "./rank-errors";
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

type CollectOutcome =
  | { status: "pending"; accounting: CollectionAccounting }
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
    return {
      status: "failed",
      failure: classifyProviderError(error, TASK_GET_ENDPOINT),
      accounting,
    };
  }

  if (outcome.status === "pending") return { status: "pending", accounting };

  if (outcome.status === "failed") {
    return {
      status: "failed",
      failure: {
        origin: "provider",
        // A task DataForSEO itself reports as failed is a different fact from a
        // transport error, and the task status code is the only thing that says
        // which — so it is carried, and nothing else from the response is.
        code: "DATAFORSEO_TASK_FAILED",
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
