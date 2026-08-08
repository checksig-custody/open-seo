import { isEnabled, type Phase0Config } from "../phase0-env";
import { resolveProviderStatus } from "./service";
import { normalizeDomain } from "./ai-visibility";
import { collectAiObservationLive } from "./ai-visibility-live";
import { AI_ENGINE_LABEL, countryCodeFor } from "./ai-visibility-collector";

/**
 * Morgana Search Intelligence — the AI Visibility provider boundary.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * **No model is reached directly from here, and none ever will be.** Not
 * OpenAI, not Anthropic, not Google, not OpenRouter: the only outbound path is
 * DataForSEO's AI Optimization surface, which brokers the model call, reports
 * what it charged and is the account this engine already budgets against.
 * Talking to a model vendor directly would mean a second credential, a second
 * bill and a second thing the Budget Authority cannot see.
 *
 * THE LIVE PATH IS NOW REAL (patch P21). It was a deliberate stub returning a
 * refusal, and the honest reason was that a credential did not exist to validate
 * it against; one does now. `ai-visibility-collector.ts` reads the answer and
 * `ai-visibility-live.ts` pays for it, and this module keeps doing the one thing
 * it always did — deciding WHICH of the three modes applies.
 *
 * A refusal still returns nothing rather than an empty answer set, because an
 * empty observation flows into the citation delta and reads as "we lost every
 * citation at once". A refusal keeps the snapshot `not_comparable`, which is the
 * honest state.
 *
 * The fixture path exists so the model, the metrics, the events, the routing
 * and the UI are exercisable end to end without a credential — and every row it
 * produces is stamped `source: "fixture"`, which the UI renders visibly.
 */

type AiProviderMode = "fixture" | "live" | "refused";

interface AiAnswerObservation {
  aiResultPresent: boolean | null;
  primaryBrandMentioned: boolean | null;
  primaryBrandCited: boolean | null;
  competitorMentions: number | null;
  competitorCitations: number | null;
  organicPosition: number | null;
  citations: {
    domain: string;
    normalizedDomain: string;
    url: string | null;
    title: string | null;
    citationOrder: number;
  }[];
  source: "dataforseo" | "fixture";
  providerStatus: string;
  comparisonStatus: "complete" | "partial" | "not_comparable";
  /** Present when the provider refused. Rendered, never swallowed. */
  refusalReason?: string;
  /**
   * What the provider stated this observation cost, and which surface produced
   * it. Carried out of the boundary rather than recomputed by the caller: the
   * snapshot, the ledger and the readiness matrix must all quote one figure.
   */
  costMicros: number;
  costStatus: "reported" | "zero" | "not_reported";
  /** The surface actually observed — a model slug when live, never a guess. */
  engineLabel: string | null;
}

interface ProviderContext {
  queryId: string;
  query: string;
  locationCode: number;
  languageCode: string;
  /** Normalized domains of our entities, so "ours" is data, not a constant. */
  primaryDomains: readonly string[];
  competitorDomains: readonly string[];
  engine: string;
}

/**
 * Deterministic pseudo-randomness from the query text.
 *
 * Fixtures must be stable: a metric that changes between two reads of the same
 * fixture would make every delta meaningless and every test flaky.
 */
function seedOf(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

const NEUTRAL_SOURCE_DOMAINS = [
  "wikipedia.org",
  "ilsole24ore.com",
  "consob.it",
  "bankingsupervision.europa.eu",
  "bitcoin.org",
];

function fixtureObservation(context: ProviderContext): AiAnswerObservation {
  const seed = seedOf(`${context.query}|${context.engine}`);
  const aiPresent = seed % 5 !== 0;
  const brandCited = aiPresent && seed % 3 === 0;
  const brandMentioned = aiPresent && (brandCited || seed % 4 !== 0);

  const citations: AiAnswerObservation["citations"] = [];
  if (aiPresent) {
    let order = 0;
    if (brandCited && context.primaryDomains[0]) {
      const domain = context.primaryDomains[0];
      citations.push({
        domain,
        normalizedDomain: normalizeDomain(domain),
        url: `https://${domain}/`,
        title: "CheckSig — custodia bitcoin",
        citationOrder: order,
      });
      order += 1;
    }
    // Competitors and neutral sources, chosen deterministically so the same
    // query always produces the same citation list.
    const competitorCount = seed % 3;
    for (let index = 0; index < competitorCount; index += 1) {
      const domain =
        context.competitorDomains[
          (seed + index) % Math.max(1, context.competitorDomains.length)
        ];
      if (!domain) continue;
      citations.push({
        domain,
        normalizedDomain: normalizeDomain(domain),
        url: `https://${domain}/`,
        title: null,
        citationOrder: order,
      });
      order += 1;
    }
    const neutral =
      NEUTRAL_SOURCE_DOMAINS[seed % NEUTRAL_SOURCE_DOMAINS.length];
    if (neutral) {
      citations.push({
        domain: neutral,
        normalizedDomain: neutral,
        url: `https://${neutral}/`,
        title: null,
        citationOrder: order,
      });
    }
  }

  const competitorCitations = citations.filter((citation) =>
    context.competitorDomains.some(
      (domain) => normalizeDomain(domain) === citation.normalizedDomain,
    ),
  ).length;

  return {
    aiResultPresent: aiPresent,
    primaryBrandMentioned: brandMentioned,
    primaryBrandCited: brandCited,
    competitorMentions: aiPresent ? seed % 4 : null,
    competitorCitations: aiPresent ? competitorCitations : null,
    organicPosition: aiPresent ? (seed % 15) + 1 : null,
    citations,
    source: "fixture",
    providerStatus: "fixture",
    comparisonStatus: "complete",
    // A fixture bought nothing. `zero` rather than `not_reported`, because this
    // IS a measurement of the cost of not calling anybody.
    costMicros: 0,
    costStatus: "zero",
    engineLabel: null,
  };
}

/** A refusal carries its reason and produces no observation at all. */
function refusal(reason: string): AiAnswerObservation {
  return {
    aiResultPresent: null,
    primaryBrandMentioned: null,
    primaryBrandCited: null,
    competitorMentions: null,
    competitorCitations: null,
    organicPosition: null,
    citations: [],
    source: "fixture",
    providerStatus: "not_configured",
    comparisonStatus: "not_comparable",
    refusalReason: reason,
    costMicros: 0,
    costStatus: "zero",
    engineLabel: null,
  };
}

function resolveMode(config: Phase0Config, env: object): AiProviderMode {
  if (
    !isEnabled(config.SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED)
  ) {
    // A PRODUCTION ENGINE NEVER MANUFACTURES AN AI OBSERVATION.
    //
    // With the live provider off — which is production's normal state — this
    // returned `fixture`, and a fixture AI observation is the worst kind this
    // subsystem could store: "the model mentioned CheckSig" is a sentence a
    // human acts on, and nothing reading D1 afterwards could tell it from an
    // observation. Phases 1, 2 and 3 each closed this hole; phase 5 still had
    // it open, and it is closed here before any collector can use it.
    //
    // Fixtures remain exactly what they are for: staging.
    if (config.SEARCH_INTELLIGENCE_ENVIRONMENT === "production") {
      return "refused";
    }
    return "fixture";
  }
  if (!isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED))
    return "refused";
  // `live` is the only status that means a usable credential is present; every
  // other one — including `budget_exhausted` — is a reason not to call out.
  return resolveProviderStatus(config, env) === "live" ? "live" : "refused";
}

/**
 * Turn a live collection into the observation the read model stores.
 *
 * MENTION AND CITATION ARE DIFFERENT FACTS, and keeping them apart is most of
 * the value of this capability. A brand is MENTIONED when the answer names it in
 * prose; it is CITED when the answer links to its domain. Being talked about
 * without being sourced is a real and common position, and collapsing the two
 * would hide exactly the case worth acting on.
 *
 * The answer text is matched here and then dropped. Nothing downstream receives
 * it, so no provider prose can reach a store, a log or a Slack message.
 */
function observationFrom(
  facts: {
    answerPresent: boolean;
    answerText: string;
    citations: AiAnswerObservation["citations"];
  },
  context: ProviderContext,
  cost: { micros: number; status: "reported" | "zero" | "not_reported" },
): AiAnswerObservation {
  const cited = (domains: readonly string[]) =>
    facts.citations.filter((citation) =>
      domains.some(
        (domain) => normalizeDomain(domain) === citation.normalizedDomain,
      ),
    ).length;

  // A domain mention is the apex label — "checksig" for `checksig.com`. Matching
  // the full host would miss every prose mention, which is most of them.
  const mentioned = (domains: readonly string[]) =>
    domains.some((domain) => {
      const label = normalizeDomain(domain).split(".")[0];
      return (
        label !== undefined &&
        label.length >= 3 &&
        facts.answerText.includes(label)
      );
    });

  const primaryCited = cited(context.primaryDomains) > 0;

  return {
    aiResultPresent: facts.answerPresent,
    // Every field below is null when there was no answer. A `false` would claim
    // we looked and were absent; we did not look at anything.
    primaryBrandMentioned: facts.answerPresent
      ? primaryCited || mentioned(context.primaryDomains)
      : null,
    primaryBrandCited: facts.answerPresent ? primaryCited : null,
    competitorMentions: facts.answerPresent
      ? context.competitorDomains.filter((domain) => mentioned([domain])).length
      : null,
    competitorCitations: facts.answerPresent
      ? cited(context.competitorDomains)
      : null,
    // NOT AVAILABLE FROM THIS SURFACE, and deliberately not invented. Organic
    // position is a SERP fact; `llm_responses` returns an answer, not a ranking,
    // and a number here would be a different metric wearing this one's name.
    organicPosition: null,
    citations: facts.answerPresent ? facts.citations : [],
    source: "dataforseo",
    providerStatus: "live",
    // `partial` is the honest ceiling for this surface: the observation is real
    // and complete for everything it can see, and it cannot see the organic
    // position that a `complete` comparison would include.
    comparisonStatus: facts.answerPresent ? "partial" : "not_comparable",
    costMicros: cost.micros,
    costStatus: cost.status,
    engineLabel: AI_ENGINE_LABEL,
  };
}

/**
 * Observe one query.
 *
 * Three outcomes and no fourth: a fixture (staging only), a live observation
 * bought through the Budget Authority, or a named refusal. The live branch is no
 * longer a placeholder — but it is still the ONLY branch that can spend, and it
 * cannot spend without a reservation.
 */
export async function observeQuery(
  config: Phase0Config,
  env: object,
  context: ProviderContext,
): Promise<AiAnswerObservation> {
  const mode = resolveMode(config, env);
  if (mode === "fixture") return fixtureObservation(context);
  if (mode === "refused") {
    if (
      !isEnabled(
        config.SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED,
      ) &&
      config.SEARCH_INTELLIGENCE_ENVIRONMENT === "production"
    ) {
      // Named, so the refusal is legible in the read model rather than looking
      // like a missing credential.
      return refusal("FIXTURE_IN_PRODUCTION");
    }
    return refusal(
      "live AI Visibility collection is refused: no usable provider credential, or paid calls are off",
    );
  }

  const outcome = await collectAiObservationLive(config, {
    queryId: context.queryId,
    query: context.query,
    countryCode: countryCodeFor(context.locationCode),
    providerConfigured: true,
  });

  if (outcome.status === "refused") {
    // A budget decision, not a provider one. It reads differently and must:
    // nothing was called, nothing was charged, and the fix is capacity or a
    // flag rather than a credential.
    return refusal(`BUDGET_REFUSED:${outcome.code}`);
  }
  if (outcome.status === "failed") {
    // The provider WAS called. The refusal shape is still right — there is no
    // observation — but the reason names the provider so nobody goes looking
    // for a budget problem that does not exist.
    return refusal(`PROVIDER_FAILED:${outcome.code}`);
  }

  return observationFrom(outcome.facts, context, {
    micros: outcome.costMicros,
    status: outcome.costStatus,
  });
}

export function providerStatusFor(config: Phase0Config, env: object): string {
  const mode = resolveMode(config, env);
  return mode === "fixture" ? "fixture" : resolveProviderStatus(config, env);
}
