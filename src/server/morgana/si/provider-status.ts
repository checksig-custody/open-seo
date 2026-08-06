import { getEnvValueSync } from "@/server/lib/runtime-env";
import { isEnabled, type Phase0Config } from "../phase0-env";

/**
 * Morgana Search Intelligence — which provider a collection will actually use.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * Extracted from `service.ts`, which imports the D1 client and therefore cannot
 * be loaded outside the Workers runtime. That is not a stylistic point: it is
 * why this decision had no test coverage, and why an inverted condition here
 * survived every suite until the first refresh after a real credential was
 * provisioned. A pure decision belongs somewhere a test can reach it.
 */

type ProviderStatus = "fixture" | "live" | "not_configured";

/**
 * Is a Search Intelligence DataForSEO credential present?
 *
 * An empty or whitespace-only secret counts as ABSENT. A binding that exists
 * but carries nothing is the shape a half-finished `wrangler secret put`
 * leaves behind, and treating it as configured would send an unauthenticated
 * request to a paid endpoint.
 */
function credentialPresent(env: object): boolean {
  const value =
    // getEnvValueSync reads an interface-typed env without an assertion and
    // applies the Morgana credential alias, so there is nothing to cast.
    getEnvValueSync(env, "DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY") ??
    getEnvValueSync(env, "DATAFORSEO_API_KEY");
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The three states, decided in the order that makes each one honest:
 *
 *   no credential          -> not_configured  (nothing to ask with)
 *   credential, spend off  -> fixture         (a key we may not use)
 *   credential, spend on   -> live
 *
 * Never reaches for Brand Monitoring's credential. `runtime-env.ts` maps the
 * upstream `DATAFORSEO_API_KEY` name onto the Search Intelligence secret, so
 * both lookups above resolve to this engine's own account and there is no path
 * to the other one.
 */
export function resolveProviderStatus(
  // Only the one flag it actually reads, so a caller — including a test — does
  // not have to construct or cast a whole Phase0Config to ask this question.
  config: Pick<Phase0Config, "SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED">,
  env: object,
): ProviderStatus {
  if (!credentialPresent(env)) return "not_configured";
  return isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED)
    ? "live"
    : "fixture";
}
