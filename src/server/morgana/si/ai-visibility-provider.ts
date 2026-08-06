import { isEnabled, type Phase0Config } from "../phase0-env";
import { resolveProviderStatus } from "./service";
import { normalizeDomain } from "./ai-visibility";

/**
 * Morgana Search Intelligence — the AI Visibility provider boundary.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * **No language model is called from here.** Not ChatGPT, not Gemini, not
 * Claude, not OpenRouter, and no prompt of any kind leaves this process. The
 * only live source contemplated is the SERP provider's AI-answer surface — the
 * same DataForSEO capability upstream's Brand Lookup uses — which reports what
 * an AI answer contained. Reading a report about an answer and generating one
 * are different acts with different costs and different failure modes.
 *
 * That live path is **not configured**. Search Intelligence has no DataForSEO
 * credential of its own and must never borrow Brand Monitoring's, so `live`
 * mode is a refusal rather than a stub: returning an empty answer set would
 * flow into the citation delta and read as "we lost every citation at once".
 * A refusal keeps the snapshot `not_comparable`, which is the honest state.
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
 * Observe one query.
 *
 * The live branch is deliberately unimplemented rather than half-implemented:
 * writing a DataForSEO request we cannot send, cannot bill and cannot test
 * against a real response would be code that only looks finished. The moment a
 * credential exists, this is the one function that changes.
 */
export async function observeQuery(
  config: Phase0Config,
  env: object,
  context: ProviderContext,
): Promise<AiAnswerObservation> {
  const mode = resolveMode(config, env);
  if (mode === "fixture") return Promise.resolve(fixtureObservation(context));
  if (
    mode === "refused" &&
    !isEnabled(
      config.SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED,
    ) &&
    config.SEARCH_INTELLIGENCE_ENVIRONMENT === "production"
  ) {
    // Named, so the refusal is legible in the read model rather than looking
    // like a missing credential.
    return Promise.resolve(refusal("FIXTURE_IN_PRODUCTION"));
  }
  return Promise.resolve(
    refusal(
      mode === "refused"
        ? "no Search Intelligence provider credential; live AI Visibility collection is refused rather than returning an empty answer"
        : "live AI Visibility collection is not implemented without a credential to validate it against",
    ),
  );
}

export function providerStatusFor(config: Phase0Config, env: object): string {
  const mode = resolveMode(config, env);
  return mode === "fixture" ? "fixture" : resolveProviderStatus(config, env);
}
