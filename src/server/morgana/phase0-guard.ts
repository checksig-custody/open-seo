import { type Phase0Config, isEnabled } from "./phase0-env";
import { incrementCounter, log } from "./phase0-logging";

/**
 * Morgana Search Intelligence — Phase 0 paid-call guard.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P4).
 *
 * Phase 0 must be incapable of spending money. Upstream already meters
 * DataForSEO through its own credit system, but that system is designed to
 * *allow* calls once credits exist. This guard sits in front of it and refuses
 * unconditionally while the Phase-0 posture holds, so the zero-spend guarantee
 * does not depend on upstream billing behaviour.
 */

type PaidCallDecision = { allowed: true } | { allowed: false; reason: string };

export const PAID_CALLS_DISABLED_REASON =
  "search intelligence paid calls are disabled (phase 0)";
export const ZERO_CAP_REASON = "search intelligence cost cap is zero (phase 0)";

/**
 * Decide whether a billable Search Intelligence call may proceed.
 *
 * The daily and monthly caps are evaluated independently of the flag: a
 * deployment that flips the flag but leaves a cap at zero is still blocked,
 * which is what makes "caps are zero" a real control rather than documentation.
 */
export function checkPaidCall(config: Phase0Config): PaidCallDecision {
  if (!isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED)) {
    return { allowed: false, reason: PAID_CALLS_DISABLED_REASON };
  }
  if (
    config.SEO_DATAFORSEO_DAILY_COST_CAP_USD === 0 ||
    config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD === 0
  ) {
    return { allowed: false, reason: ZERO_CAP_REASON };
  }
  return { allowed: true };
}

/**
 * Guard a billable operation. Records the block and throws — callers in the
 * SEO paths are not expected to handle this gracefully during Phase 0, because
 * during Phase 0 they are not supposed to run at all.
 */
export function assertPaidCallAllowed(
  config: Phase0Config,
  operation: string,
): void {
  const decision = checkPaidCall(config);
  if (decision.allowed) {
    return;
  }
  incrementCounter("paid_calls_blocked");
  log("warn", config.SEARCH_INTELLIGENCE_ENVIRONMENT, {
    event: "paid_call_blocked",
    request_id: "n/a",
    operation,
    error_code: "PAID_CALLS_BLOCKED",
    reason: decision.reason,
  });
  throw new Error(
    `Blocked billable operation "${operation}": ${decision.reason}`,
  );
}

/**
 * The Critical staging incident condition from the Phase-0 brief: paid calls
 * are supposed to be off, yet something metered a request. Surfaced by
 * /internal/status so a smoke test can assert it, and logged at error level.
 */
export function detectMeteredWhileDisabled(
  config: Phase0Config,
  meteredRequests: number,
): boolean {
  const breached =
    !isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED) &&
    meteredRequests > 0;
  if (breached) {
    log("error", config.SEARCH_INTELLIGENCE_ENVIRONMENT, {
      event: "paid_calls_disabled_but_metered",
      request_id: "n/a",
      error_code: "CRITICAL_UNEXPECTED_SPEND",
      metered_requests: meteredRequests,
    });
  }
  return breached;
}
