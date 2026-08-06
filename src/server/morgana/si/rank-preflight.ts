import { isEnabled, type Phase0Config } from "../phase0-env";
import { refusal, type TypedFailure } from "./rank-errors";

/**
 * Morgana Search Intelligence — the live rank pre-flight.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * IN THE ENGINE, ON PURPOSE. Phase 1's pre-flight lived in a verification
 * script, which is fine for a human running one experiment and useless as a
 * guarantee: a script cannot protect a call made by a scheduler, by a future
 * endpoint, or by anyone who did not read the runbook. The condition that
 * decides whether money may be spent belongs next to the spending.
 *
 * Every check is a refusal, never a warning. A pre-flight that logs and
 * proceeds is a pre-flight that has already failed at its job.
 */

interface PreflightContext {
  config: Phase0Config;
  providerStatus: "not_configured" | "fixture" | "live";
  /** Ledger-derived, in micro-USD. Not the cap: what has actually been spent. */
  dailySpentMicros: number;
  monthlySpentMicros: number;
  /** The most a single submission could cost, used as the headroom test. */
  worstCaseCostMicros: number;
}

type PreflightResult =
  | { ok: true }
  | { ok: false; failure: TypedFailure; reason: string };

const fail = (
  reason: string,
  origin: Parameters<typeof refusal>[0],
  code: Parameters<typeof refusal>[1],
  message: string,
): PreflightResult => ({
  ok: false,
  failure: refusal(origin, code, message),
  reason,
});

/**
 * May a paid SERP submission happen right now?
 *
 * Ordered so the answer names the FIRST thing that is wrong, and so the
 * cheapest, most fundamental checks come first: there is no point reasoning
 * about budget headroom for an engine that has no credential.
 *
 * The budget test uses the WORST CASE cost of the submission, not an average
 * and not the last observed price. A cap that is only respected on average is
 * not a cap, and DataForSEO's charge is known only after the call — so the only
 * safe question before it is "if this costs the most it could, are we still
 * inside the limit".
 */
export function rankPreflight(context: PreflightContext): PreflightResult {
  const { config, providerStatus } = context;

  if (config.SEARCH_INTELLIGENCE_ENVIRONMENT !== "production") {
    // Not an error in staging — the caller decides whether to care — but this
    // function only ever authorises PRODUCTION spend.
    return fail(
      "not_production",
      "configuration",
      "LIVE_PROVIDER_DISABLED",
      "live rank collection is authorised only in production",
    );
  }
  if (!isEnabled(config.SEARCH_INTELLIGENCE_ENABLED)) {
    return fail(
      "search_intelligence_disabled",
      "configuration",
      "LIVE_PROVIDER_DISABLED",
      "search intelligence is disabled",
    );
  }
  if (providerStatus === "not_configured") {
    return fail(
      "credential_not_configured",
      "configuration",
      "PROVIDER_NOT_CONFIGURED",
      "no Search Intelligence DataForSEO credential",
    );
  }
  if (providerStatus === "fixture") {
    // Reaching here in production means a credential exists but spend is off.
    // A fixture must never stand in for a rank: a synthetic position in the
    // production database is indistinguishable from a measured one.
    return fail(
      "fixture_path_unavailable",
      "configuration",
      "FIXTURE_IN_PRODUCTION",
      "a production engine will not manufacture a fixture ranking",
    );
  }
  if (!isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED)) {
    return fail(
      "paid_calls_disabled",
      "configuration",
      "LIVE_PROVIDER_DISABLED",
      "paid calls are disabled",
    );
  }

  const dailyCap = config.SEO_DATAFORSEO_DAILY_COST_CAP_USD;
  const monthlyCap = config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD;
  if (dailyCap <= 0 || monthlyCap <= 0) {
    // Zero is the fail-safe value everywhere in this engine: an absent cap
    // means "cannot spend", never "unlimited".
    return fail(
      "cap_not_set",
      "configuration",
      "BUDGET_EXHAUSTED",
      "a zero cost cap means spending is not authorised",
    );
  }

  // Headroom, measured against what the ledger says has actually been spent.
  if (context.dailySpentMicros + context.worstCaseCostMicros > dailyCap) {
    return fail(
      "daily_budget_insufficient",
      "budget",
      "BUDGET_EXHAUSTED",
      "the worst-case cost of this submission would exceed the daily cap",
    );
  }
  if (context.monthlySpentMicros + context.worstCaseCostMicros > monthlyCap) {
    return fail(
      "monthly_budget_insufficient",
      "budget",
      "BUDGET_EXHAUSTED",
      "the worst-case cost of this submission would exceed the monthly cap",
    );
  }

  return { ok: true };
}
