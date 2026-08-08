import { fetchUserData } from "@/server/lib/dataforseo/appendix";
import { fetchLlmModels } from "@/server/lib/dataforseo/ai";
import type { Phase0Config } from "../phase0-env";
import {
  classifyProviderAccountEvent,
  latchProviderState,
  readProviderState,
  recordProviderHealthy,
  sanitizeProviderMessage,
  type ProviderCircuitState,
} from "./provider-circuit";

/**
 * Morgana Search Intelligence — is the provider account usable, for free?
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P20).
 *
 * NEVER USE A PAID CALL TO VERIFY A CREDENTIAL. That rule is the whole reason
 * this file exists: the obvious way to find out whether a DataForSEO key works
 * is to buy something with it, and doing that on a suspended or wrong account
 * is how a verification turns into an unexplained charge.
 *
 * Two endpoints, both documented by the provider as non-billable:
 *
 *   GET /v3/appendix/user_data
 *       Account login, lifetime deposit, remaining balance, and spend per
 *       function for the rolling day and minute. `appendix.ts` states in its own
 *       words that it is free and is deliberately not metered.
 *
 *   GET /v3/ai_optimization/{model}/llm_responses/models
 *       "Your account will not be charged for using this API." A catalogue,
 *       so it answers whether the AI Optimization API is REACHABLE.
 *
 * WHAT THE SECOND ONE DOES NOT PROVE. A free catalogue endpoint answering is
 * not the same as this account being entitled to the billable `llm_responses`
 * surface, and this module will not report it as such. It is recorded as
 * `api_reachable`, which is exactly what was observed. The distinction is the
 * same one the readiness matrix makes everywhere else: what was verified, not
 * what would be convenient to claim.
 *
 * THIS IS ALSO HOW WE LEARN WHICH ACCOUNT IS INSTALLED, without ever reading
 * the secret. `user_data` returns the login and the lifetime deposit; a
 * dismissed trial and a funded paid account do not look alike.
 */

type AuthVerification =
  /** A free call succeeded. A real round trip, not an inference. */
  | "live_auth_verified"
  /** A credential exists but nothing has asked the provider yet. */
  | "live_auth_verification_pending"
  /** The provider answered, and the answer was about the account. */
  | "account_blocked"
  /** No credential at all. */
  | "not_configured";

interface ProviderHealth {
  /** Whether a credential is present. Never the credential. */
  configured: boolean;
  authVerification: AuthVerification;
  /** The latched circuit state, or null when the provider was never observed. */
  circuitState: ProviderCircuitState | null;
  circuitRequiresAttention: boolean;
  /** Non-sensitive account label from configuration. */
  accountGeneration: string;
  /**
   * The provider's own view of the account. Present only when `user_data`
   * answered. `login` is an account identifier, not a credential — it is half
   * of a basic-auth pair and useless alone — and it is the only reliable way to
   * tell the dismissed trial from the official account.
   */
  account: {
    login: string | null;
    lifetimeDepositUsdMicros: number | null;
    balanceUsdMicros: number | null;
    /** Rolling-day spend per provider function, in integer micro-USD. */
    spendByFunctionMicros: Record<string, number>;
  } | null;
  /** Was the AI Optimization catalogue reachable? Never an entitlement claim. */
  aiOptimization: "api_reachable" | "unreachable" | "not_checked";
  /** Provider text, scrubbed. Null when nothing went wrong. */
  message: string | null;
  /** Zero. Stated rather than implied, because a reader will want to know. */
  costMicros: 0;
}

/** USD floats from the provider become integer micro-USD at the boundary. */
function toMicros(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 1_000_000);
}

/**
 * Spend per provider function for the rolling day.
 *
 * Kept as whatever keys DataForSEO actually sent rather than mapped onto this
 * engine's collector names: these are the PROVIDER's numbers, and reshaping
 * them into our vocabulary would quietly assert a correspondence that the
 * reconciliation exists to establish rather than assume.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function spendByFunction(stats: unknown): Record<string, number> {
  if (!isRecord(stats)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (!key.startsWith("total_")) continue;
    const micros = toMicros(value);
    if (micros !== null && micros > 0) out[key.slice("total_".length)] = micros;
  }
  return out;
}

/**
 * Ask the provider, for free, whether this account can be used.
 *
 * Never throws for a provider failure: the caller is a status surface and an
 * exception there would be indistinguishable from the engine being broken.
 * An account-level answer LATCHES the circuit breaker, including when it is
 * good news — a healthy free check is one of the three legitimate ways a latch
 * may be lifted, and recording it is what makes that possible.
 */
export async function checkProviderHealth(
  config: Phase0Config,
  options: { credentialPresent: boolean; checkAi?: boolean; now?: Date } = {
    credentialPresent: false,
  },
): Promise<ProviderHealth> {
  const generation = config.SEARCH_INTELLIGENCE_PROVIDER_ACCOUNT_GENERATION;
  const existing = await readProviderState();
  const base: ProviderHealth = {
    configured: options.credentialPresent,
    authVerification: options.credentialPresent
      ? "live_auth_verification_pending"
      : "not_configured",
    circuitState: existing?.state ?? null,
    circuitRequiresAttention: existing?.requiresAttention ?? false,
    accountGeneration: generation,
    account: null,
    aiOptimization: "not_checked",
    message: null,
    costMicros: 0,
  };

  // Nothing to ask with. Not an error and not a failure — just a state.
  if (!options.credentialPresent) return base;

  let account: ProviderHealth["account"] = null;
  try {
    const data = await fetchUserData();
    if (data) {
      // The SDK types every field optional with index signatures, so this walks
      // down with checks rather than assertions: a shape the provider changed
      // should read as absent data, never as a cast that lands somewhere wrong.
      const money = isRecord(data.money) ? data.money : null;
      const statistics =
        money && isRecord(money.statistics) ? money.statistics : null;
      account = {
        login: typeof data.login === "string" ? data.login : null,
        lifetimeDepositUsdMicros: toMicros(money?.total),
        balanceUsdMicros: toMicros(money?.balance),
        spendByFunctionMicros: spendByFunction(statistics?.day),
      };
    }
  } catch (error) {
    const event = classifyProviderAccountEvent(error);
    if (event.kind !== "none" && event.kind !== "rate_limited") {
      await latchProviderState({
        state: event.kind,
        endpoint: "/v3/appendix/user_data",
        operationType: "provider_health",
        providerStatusCode: event.statusCode,
        sanitizedMessage: event.sanitizedMessage,
        credentialGeneration: generation,
        now: options.now,
      });
      return {
        ...base,
        authVerification: "account_blocked",
        circuitState: event.kind,
        circuitRequiresAttention: true,
        message: event.sanitizedMessage,
      };
    }
    // A transport hiccup or an unrecognised code teaches us nothing about the
    // account, so nothing is latched and nothing is claimed.
    return {
      ...base,
      message: sanitizeProviderMessage(
        error instanceof Error ? error.message : null,
      ),
    };
  }

  // The account answered. That IS the verification — a free round trip that
  // could only have succeeded with a usable credential.
  await recordProviderHealthy({
    credentialGeneration: generation,
    now: options.now,
  });

  let aiOptimization: ProviderHealth["aiOptimization"] = "not_checked";
  if (options.checkAi !== false) {
    try {
      await fetchLlmModels("chat_gpt");
      aiOptimization = "api_reachable";
    } catch (error) {
      const event = classifyProviderAccountEvent(error);
      // A refusal HERE is capability-scoped: `user_data` already proved the
      // credential works, so this is the account not being entitled to AI
      // Optimization rather than the account being unusable. It is reported,
      // and deliberately does NOT latch the global breaker — doing so would
      // stop ranking and backlinks over an AI entitlement.
      aiOptimization = "unreachable";
      base.message = event.sanitizedMessage;
    }
  }

  const after = await readProviderState();
  return {
    ...base,
    authVerification: "live_auth_verified",
    circuitState: after?.state ?? "healthy",
    circuitRequiresAttention: after?.requiresAttention ?? false,
    account,
    aiOptimization,
  };
}
