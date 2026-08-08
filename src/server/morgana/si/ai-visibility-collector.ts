import { loadDataforseoSections } from "@/server/lib/dataforseo/client";
import {
  accountFor,
  readProviderCost,
  type CollectionAccounting,
} from "./collection-accounting";
import { classifyProviderError, type TypedFailure } from "./rank-errors";
import { observeProviderError } from "./provider-circuit";
import { normalizeDomain } from "./ai-visibility";

/**
 * Morgana Search Intelligence — the live AI Visibility collector.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P21).
 *
 * THIS IS THE STUB THAT USED TO BE HERE, WRITTEN. `observeQuery` had a live
 * branch that returned a refusal and never reached DataForSEO, and the readiness
 * matrix reported `implementation: implemented` beside it — which read as "built,
 * waiting for one authorised call" and would have sent someone to arm paid calls
 * and watch nothing happen. The collector is now real, and the readiness row can
 * stop apologising for it.
 *
 * WHY `llm_responses` AND NOT `llm_mentions`. The unit of this subsystem is a
 * QUERY: "when somebody asks an assistant this, does the answer mention us and
 * what does it cite". `llm_responses/live` takes a prompt and returns that
 * answer with its annotations, which is the same question. `llm_mentions/*` is
 * an aggregate over a corpus of answers to questions nobody here asked; it is a
 * different metric wearing a similar name, and at $0.1 per request plus $0.001
 * per row it also costs roughly a hundred times more per observation than the
 * whole daily cap can absorb.
 *
 * THE ANSWER TEXT IS UNTRUSTED AND IS NEVER STORED. What comes back is a
 * language model's prose about our brand, produced from web pages we did not
 * write. Nothing here interprets it, no model is asked about it, and no part of
 * it is persisted: this module reduces it to booleans and citation DOMAINS
 * before returning, and the snapshot table has no column that could hold the
 * text even if a future caller wanted to. Instruction-shaped sentences inside an
 * answer therefore have nothing to act on.
 */

/**
 * The model this engine observes with, and why it is one model and not four.
 *
 * Every additional model is another full-price call per query per cycle, and
 * this capability has to fit inside a 0.20 USD day alongside three other paid
 * collectors. `perplexity/sonar` is the cheapest of the four accepted slugs to
 * run with web search on — which is the mode that matters, because an answer
 * composed without retrieval cites nothing and would report every brand as
 * uncited.
 *
 * `ACCEPTED_LLM_MODEL_NAMES` in the client validates this before dispatch, and
 * DataForSEO BILLS a task rejected for a bad `model_name`, so a stale value here
 * is a charge for nothing. Changing it means checking that list first.
 */
export const AI_MODEL_SLUG = "perplexity" as const;
export const AI_MODEL_NAME = "sonar";
export const AI_ENGINE_LABEL = `perplexity/${AI_MODEL_NAME}`;

export const AI_RESPONSES_ENDPOINT = `v3/ai_optimization/${AI_MODEL_SLUG}/llm_responses/live`;

/**
 * The output-token ceiling, which is the only part of the price we control.
 *
 * DataForSEO charges a published 600 µUSD base fee PLUS the model provider's own
 * token charge, which it does not publish and cannot be predicted before the
 * call. `max_output_tokens` is the lever that bounds the second term: an answer
 * that cannot exceed 512 tokens cannot bill for 4 096 of them. It is deliberately
 * small — this reads whether a brand is named and what is cited, not the essay.
 */
export const AI_MAX_OUTPUT_TOKENS = 512;

/**
 * The most one observation could plausibly cost, in µUSD, for the reservation.
 *
 * NOT AN ESTIMATE OF THE PRICE — an upper bound the Budget Authority holds until
 * the provider states the real figure. DataForSEO's own worked example for
 * `llm_responses` totals $0.029631 at a larger token ceiling than this one uses,
 * so 60 000 is roughly double a documented worst case and still under a third of
 * the daily cap. The first live call replaces this guess with a measurement; the
 * guess exists so that call cannot be unbounded.
 */
export const WORST_CASE_AI_RESPONSE_MICROS = 60_000;

/**
 * DataForSEO geotarget code to the ISO country the web-search component uses.
 *
 * EXPLICIT, AND SHORT ON PURPOSE. There is no arithmetic relationship between a
 * geotarget code and an ISO code, and the provider's own list is ~100 000 rows
 * behind a paid-account endpoint. This table holds the markets this deployment
 * actually targets; anything else returns `null`, the field is omitted, and the
 * search is simply not geolocated. Guessing a country would silently observe the
 * wrong market and report it as this one's.
 */
const COUNTRY_BY_LOCATION_CODE: Record<number, string> = {
  2380: "IT",
  2840: "US",
  2826: "GB",
  2276: "DE",
  2250: "FR",
  2724: "ES",
  2756: "CH",
};

export function countryCodeFor(locationCode: number): string | null {
  return COUNTRY_BY_LOCATION_CODE[locationCode] ?? null;
}

export interface AiCitation {
  domain: string;
  normalizedDomain: string;
  url: string | null;
  title: string | null;
  citationOrder: number;
}

export interface AiAnswerFacts {
  /** Did the provider return an answer at all? */
  answerPresent: boolean;
  /** Every distinct domain the answer cited, in the order first cited. */
  citations: AiCitation[];
  /** Lower-cased answer text, for mention matching. NEVER persisted. */
  answerText: string;
  /** What the model reported spending, when it said. Drives the cost model. */
  outputTokens: number | null;
  modelName: string | null;
}

export type AiCollectOutcome =
  | {
      status: "completed";
      facts: AiAnswerFacts;
      accounting: CollectionAccounting;
      endpoint: string;
    }
  | {
      status: "failed";
      failure: TypedFailure;
      accounting: CollectionAccounting;
    };

/** A host, if this is a parseable absolute http(s) URL. Never a guess. */
function hostOf(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.hostname === "" ? null : parsed.hostname;
}

/**
 * Reduce a provider response to the few facts this subsystem records.
 *
 * Exported because this — not the network call — is where an observation is
 * actually decided, and it must be assertable without a provider in the way.
 *
 * A citation is counted ONCE per normalized domain. An answer that footnotes the
 * same site five times has cited one source, and counting five would make
 * "citations" a measure of formatting rather than of visibility.
 */
export function extractAnswerFacts(result: {
  items?: unknown;
  model_name?: string | null;
  output_tokens?: number | null;
}): AiAnswerFacts {
  const items = Array.isArray(result.items) ? result.items : [];
  const textParts: string[] = [];
  const citations: AiCitation[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const sections = (item as { sections?: unknown }).sections;
    if (!Array.isArray(sections)) continue;
    for (const section of sections) {
      if (typeof section !== "object" || section === null) continue;
      const text = (section as { text?: unknown }).text;
      if (typeof text === "string" && text !== "") textParts.push(text);

      const annotations = (section as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (typeof annotation !== "object" || annotation === null) continue;
        const url = (annotation as { url?: unknown }).url;
        const host = hostOf(typeof url === "string" ? url : null);
        if (!host) continue;
        const normalized = normalizeDomain(host);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const title = (annotation as { title?: unknown }).title;
        citations.push({
          domain: host,
          normalizedDomain: normalized,
          url: typeof url === "string" ? url : null,
          title: typeof title === "string" && title !== "" ? title : null,
          citationOrder: citations.length,
        });
      }
    }
  }

  const answerText = textParts.join("\n").toLowerCase();
  const outputTokens =
    typeof result.output_tokens === "number" &&
    Number.isFinite(result.output_tokens) &&
    result.output_tokens >= 0
      ? Math.round(result.output_tokens)
      : null;

  return {
    // An answer with neither prose nor a citation is not an answer. Reporting
    // `true` here would let an empty response read as "the assistant answered
    // and did not mention us", which is a finding rather than a blank.
    answerPresent: answerText !== "" || citations.length > 0,
    citations,
    answerText,
    outputTokens,
    modelName:
      typeof result.model_name === "string" && result.model_name !== ""
        ? result.model_name
        : null,
  };
}

/**
 * Buy one AI answer.
 *
 * Throws nothing. A provider failure returns typed, with the request still
 * accounted at a NOT-REPORTED cost, because the call happened and DataForSEO
 * bills some failures — an error must never be recorded as a free observation.
 */
export async function collectAiAnswer(input: {
  query: string;
  /** Two-letter ISO country code that geolocates the web-search component. */
  countryCode: string | null;
}): Promise<AiCollectOutcome> {
  try {
    const sections = await loadDataforseoSections();
    const response = await sections.fetchLlmResponse({
      userPrompt: input.query,
      modelSlug: AI_MODEL_SLUG,
      modelName: AI_MODEL_NAME,
      // Retrieval ON. An answer generated without it cites nothing, and a
      // citation count of zero would then measure the request, not the brand.
      webSearch: true,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
      ...(input.countryCode ? { webSearchCountryCode: input.countryCode } : {}),
    });

    const cost = readProviderCost(response.billing);
    const endpoint = response.billing.path.join("/");
    return {
      status: "completed",
      facts: extractAnswerFacts(response.data),
      accounting: accountFor([{ endpointPath: endpoint, cost }], {
        metered: true,
        paidSubmission: true,
      }),
      endpoint,
    };
  } catch (error) {
    const accounting = accountFor(
      [
        {
          endpointPath: AI_RESPONSES_ENDPOINT,
          cost: { micros: null, status: "not_reported" },
        },
      ],
      { metered: true, paidSubmission: true },
    );
    // A `40201` here latches the breaker for the whole subsystem, exactly as it
    // does for the other three collectors. AI Visibility is not a special case.
    await observeProviderError(error, {
      endpoint: AI_RESPONSES_ENDPOINT,
      operationType: "llm_responses",
    });
    return {
      status: "failed",
      failure: classifyProviderError(error, AI_RESPONSES_ENDPOINT),
      accounting,
    };
  }
}
