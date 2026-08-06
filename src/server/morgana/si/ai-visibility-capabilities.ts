import { isEnabled, type Phase0Config } from "../phase0-env";

/**
 * Morgana Search Intelligence — what AI Visibility can actually reach.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P15).
 *
 * DISCOVERED WITHOUT SPENDING ANYTHING. Every entry below comes from code that
 * is in this repository — the upstream client's endpoints, its verified model
 * catalogue, its request validation — and not from a probe. Asking a paid API
 * what it supports is a strange way to find out what it supports when the
 * client that calls it is sitting in `src/server/lib/dataforseo/ai.ts`.
 *
 * THREE THINGS ARE DELIBERATELY DIFFERENT STATES, because collapsing them is
 * how a UI ends up claiming coverage nobody has:
 *
 *   `supported`                  — an endpoint exists and this engine can call it.
 *   `supported_but_not_configured` — the endpoint exists; something local is off.
 *   `paid_verification_required` — the endpoint exists, but whether THIS account
 *                                  may call it can only be learned by calling it.
 *   `unsupported`                — no endpoint in the client at all.
 *
 * A UI tab is not evidence. Neither is a fixture. The last column of every row
 * here is the file and symbol the claim rests on.
 */

type EngineCapabilityStatus =
  | "supported"
  | "supported_but_not_configured"
  | "unsupported"
  | "capability_unknown"
  | "paid_verification_required"
  | "account_not_enabled";

interface EngineCapability {
  engine: string;
  surface: "llm_answer" | "llm_mentions" | "generative_serp";
  status: EngineCapabilityStatus;
  /** The upstream symbol this claim rests on, or null when there is none. */
  evidence: string | null;
  /** Model identifiers the client will actually accept, when it validates them. */
  models: string[];
  notes: string;
}

/**
 * The verified catalogue, mirrored from the upstream client's own validation.
 *
 * `fetchLlmResponse` rejects any `model_name` outside these sets before a
 * request is made, so this list is not a guess about the provider — it is the
 * contract this engine is already held to.
 */
const LLM_MODELS: Record<string, string[]> = {
  chat_gpt: ["gpt-5"],
  claude: ["claude-sonnet-4-5", "claude-sonnet-4-6"],
  gemini: ["gemini-2.5-pro"],
  perplexity: ["sonar-reasoning-pro", "sonar-pro", "sonar"],
};

/**
 * What is reachable, and on what evidence.
 *
 * `paid_verification_required` is the honest status for every LLM answer
 * surface: the endpoints exist and the models are validated, but whether this
 * particular DataForSEO account has AI Optimization enabled cannot be known
 * without a billable call — and this session makes none.
 */
export function engineCapabilities(): EngineCapability[] {
  const llm: EngineCapability[] = Object.entries(LLM_MODELS).map(
    ([slug, models]) => ({
      engine: slug,
      surface: "llm_answer",
      status: "paid_verification_required",
      evidence: "server/lib/dataforseo/ai.ts:fetchLlmResponse",
      models,
      notes:
        slug === "gemini"
          ? "the client omits `country` for this model, which the provider rejects for it"
          : "endpoint and model catalogue verified in the client's own validation",
    }),
  );

  return [
    ...llm,
    {
      engine: "llm_mentions",
      surface: "llm_mentions",
      status: "paid_verification_required",
      evidence: "server/lib/dataforseo/ai.ts:fetchLlmMentionsSearch",
      models: [],
      notes:
        "aggregated mention search across models; account entitlement unverified",
    },
    {
      engine: "google_ai_overview",
      surface: "generative_serp",
      status: "capability_unknown",
      // The SERP item type exists in the Labs typing, which proves the shape is
      // known — not that a collection path exists here.
      evidence: "server/lib/dataforseo/labs.ts:ai_overview_reference",
      models: [],
      notes:
        "the item type is modelled, but no collector reads it; it would ride on the SERP endpoint, not on AI Optimization",
    },
    {
      engine: "bing_copilot",
      surface: "llm_answer",
      status: "unsupported",
      evidence: null,
      models: [],
      notes: "no endpoint for it exists in the client",
    },
  ];
}

interface AiVisibilityReadiness {
  /** What this engine could reach if everything were switched on. */
  capabilities: EngineCapability[];
  /** Whether the deploy allows live collection at all. */
  liveProviderEnabled: boolean;
  paidCallsEnabled: boolean;
  credentialConfigured: boolean;
  environment: string;
  /**
   * The single honest answer to "is AI Visibility live".
   *
   * `unsupported_or_not_enabled` is reserved for a provider that genuinely
   * cannot serve us; `not_configured` is a local switch. A reader who cannot
   * tell those apart will go and fix the wrong thing.
   */
  status:
    | "live_ready"
    | "not_configured"
    | "unsupported_or_not_enabled"
    | "paid_verification_required";
  /** Why, in this engine's own words. */
  reason: string;
}

export function aiVisibilityReadiness(
  config: Phase0Config,
  credentialConfigured: boolean,
): AiVisibilityReadiness {
  const capabilities = engineCapabilities();
  const liveProviderEnabled = isEnabled(
    config.SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED,
  );
  const paidCallsEnabled = isEnabled(
    config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED,
  );

  const anythingReachable = capabilities.some(
    (capability) =>
      capability.status === "supported" ||
      capability.status === "paid_verification_required",
  );

  const status: AiVisibilityReadiness["status"] = !anythingReachable
    ? "unsupported_or_not_enabled"
    : !credentialConfigured
      ? "not_configured"
      : !liveProviderEnabled || !paidCallsEnabled
        ? "not_configured"
        : "paid_verification_required";

  const reason = !anythingReachable
    ? "no AI surface is reachable from the client in this build"
    : !credentialConfigured
      ? "no Search Intelligence DataForSEO credential"
      : !liveProviderEnabled
        ? "the AI live provider switch is off"
        : !paidCallsEnabled
          ? "paid calls are off"
          : "the endpoints exist; this account's entitlement is unverified and only a billable call can settle it";

  return {
    capabilities,
    liveProviderEnabled,
    paidCallsEnabled,
    credentialConfigured,
    environment: config.SEARCH_INTELLIGENCE_ENVIRONMENT,
    status,
    reason,
  };
}
