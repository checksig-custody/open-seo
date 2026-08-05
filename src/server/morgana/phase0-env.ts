import { z } from "zod";
import { getEnvValueSync } from "@/server/lib/runtime-env";

/**
 * Morgana Search Intelligence — Phase 0 configuration.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P4). This module is additive: no
 * upstream file reads it except the three lines patched into `src/server.ts`.
 *
 * Phase 0 imports no SEO functionality. The engine must be able to boot,
 * authenticate, and report health/readiness/status while every paid capability
 * is off and both DataForSEO cost caps are hard zero.
 */

const boolFlag = z.enum(["true", "false"]);

/**
 * Caps are USD *strings* in config and parsed to integer micro-USD here.
 * Morgana's own convention is integer micro-USD everywhere precisely so money
 * never touches a float (Morgana decision #3); the same rule applies to the
 * engine so the two ledgers can be compared without a unit conversion bug.
 */
const usdCapToMicros = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, "cost cap must be a non-negative USD amount")
  .transform((value) => Math.round(Number(value) * 1_000_000));

export const phase0EnvSchema = z
  .object({
    SEARCH_INTELLIGENCE_ENABLED: boolFlag.default("false"),
    SEARCH_INTELLIGENCE_STAGING_ENABLED: boolFlag.default("false"),
    SEARCH_INTELLIGENCE_UI_ENABLED: boolFlag.default("false"),
    SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: boolFlag.default("false"),
    SEARCH_INTELLIGENCE_MCP_ENABLED: boolFlag.default("false"),
    SEARCH_INTELLIGENCE_AI_ENABLED: boolFlag.default("false"),
    SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED: boolFlag.default("false"),
    // Defaults are the transformed output (integer micro-USD), because Zod 4
    // applies `.default()` after the pipe. Zero is the fail-safe value: an
    // absent cap must mean "cannot spend", never "unlimited".
    SEO_DATAFORSEO_DAILY_COST_CAP_USD: usdCapToMicros.default(0),
    SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: usdCapToMicros.default(0),
    SEARCH_INTELLIGENCE_ENVIRONMENT: z
      .enum(["staging", "production"])
      .default("staging"),
    SEARCH_INTELLIGENCE_API_VERSION: z.string().min(1).default("2026-08-05"),
    ENGINE_UPSTREAM_REPOSITORY: z
      .string()
      .default("https://github.com/every-app/open-seo"),
    ENGINE_UPSTREAM_RELEASE: z.string().default("unknown"),
    ENGINE_UPSTREAM_COMMIT: z.string().default("unknown"),
    ENGINE_LOCAL_COMMIT: z.string().default("unknown"),
    ENGINE_DEPLOYED_AT: z.string().default("unknown"),
  })
  .superRefine((cfg, ctx) => {
    // The Phase-0 brief is explicit: enabling a paid capability against a zero
    // budget must fail the build, not silently spend. Boot is the last place
    // this can be caught, and failing closed here means a misconfigured deploy
    // is inert rather than expensive.
    if (cfg.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED === "true") {
      if (
        cfg.SEO_DATAFORSEO_DAILY_COST_CAP_USD === 0 ||
        cfg.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD === 0
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED=true requires both " +
            "SEO_DATAFORSEO_DAILY_COST_CAP_USD and " +
            "SEO_DATAFORSEO_MONTHLY_COST_CAP_USD to be greater than zero",
        });
      }
      // A paid call is only meaningful once the engine's own credential exists.
      // Morgana's Brand Monitoring credential is deliberately NOT accepted here.
      if (cfg.SEARCH_INTELLIGENCE_ENABLED === "false") {
        ctx.addIssue({
          code: "custom",
          message:
            "SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED=true requires " +
            "SEARCH_INTELLIGENCE_ENABLED=true",
        });
      }
    }
    // A daily cap above the monthly cap is always a configuration error.
    if (
      cfg.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD > 0 &&
      cfg.SEO_DATAFORSEO_DAILY_COST_CAP_USD >
        cfg.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "SEO_DATAFORSEO_DAILY_COST_CAP_USD must not exceed " +
          "SEO_DATAFORSEO_MONTHLY_COST_CAP_USD",
      });
    }
  });

export type Phase0Config = z.infer<typeof phase0EnvSchema>;

const PHASE0_ENV_KEYS = [
  "SEARCH_INTELLIGENCE_ENABLED",
  "SEARCH_INTELLIGENCE_STAGING_ENABLED",
  "SEARCH_INTELLIGENCE_UI_ENABLED",
  "SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED",
  "SEARCH_INTELLIGENCE_MCP_ENABLED",
  "SEARCH_INTELLIGENCE_AI_ENABLED",
  "SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED",
  "SEO_DATAFORSEO_DAILY_COST_CAP_USD",
  "SEO_DATAFORSEO_MONTHLY_COST_CAP_USD",
  "SEARCH_INTELLIGENCE_ENVIRONMENT",
  "SEARCH_INTELLIGENCE_API_VERSION",
  "ENGINE_UPSTREAM_REPOSITORY",
  "ENGINE_UPSTREAM_RELEASE",
  "ENGINE_UPSTREAM_COMMIT",
  "ENGINE_LOCAL_COMMIT",
  "ENGINE_DEPLOYED_AT",
] as const;

/**
 * Parse Phase-0 configuration from a Workers env. Throws on invalid config —
 * the caller turns that into a 500 rather than serving a Worker whose spend
 * posture is unknown.
 */
export function readPhase0Config(env: object): Phase0Config {
  const raw: Record<string, string> = {};
  for (const key of PHASE0_ENV_KEYS) {
    const value = getEnvValueSync(env, key);
    if (value !== undefined) {
      raw[key] = value;
    }
  }
  return phase0EnvSchema.parse(raw);
}

export function isEnabled(value: "true" | "false"): boolean {
  return value === "true";
}
