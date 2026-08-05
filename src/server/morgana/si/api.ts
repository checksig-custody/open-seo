import { isEnabled, readPhase0Config, type Phase0Config } from "../phase0-env";
import { incrementCounter, log, requestIdFor } from "../phase0-logging";
import { DomainValidationError } from "./domains";
import { badRequest, json, SI_PATH_PREFIX } from "./http";
import { dispatch } from "./router";
import * as service from "./service";

/**
 * Morgana Search Intelligence — private API entry point.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Reachable only over Morgana's Service Binding: this Worker has no route and
 * `workers_dev: false`, so nothing here is exposed to the internet. Morgana is
 * the sole caller and performs all user authentication and authorisation before
 * a request arrives — this layer's job is to be a correct, versioned,
 * non-leaking data surface, not an auth boundary.
 *
 * The route table lives in `router.ts`; this file owns the posture around it:
 * the feature gate, the logging, and turning any failure into a sanitized
 * response.
 */
export async function handleSearchIntelligenceRequest(
  request: Request,
  env: object,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(SI_PATH_PREFIX)) return null;

  const requestId = requestIdFor(request);
  const started = Date.now();
  incrementCounter("service_binding_requests");

  let config: Phase0Config;
  try {
    config = readPhase0Config(env);
  } catch {
    // Invalid configuration means the spend posture is unknown. Fail closed,
    // and say nothing about which value was wrong.
    incrementCounter("service_binding_failures");
    return json({ error: "invalid engine configuration" }, 500);
  }

  // The whole surface is behind the master flag. With it off the engine behaves
  // as though Search Intelligence does not exist, which is what makes the
  // Morgana-side kill switch total rather than cosmetic.
  if (!isEnabled(config.SEARCH_INTELLIGENCE_ENABLED)) {
    return json(
      { error: "search intelligence is disabled", code: "feature_disabled" },
      404,
    );
  }

  const route = url.pathname.slice(SI_PATH_PREFIX.length);
  const providerStatus = service.resolveProviderStatus(config, env);

  try {
    const response = await dispatch({
      route,
      request,
      url,
      config,
      env,
      providerStatus,
    });
    log("info", config.SEARCH_INTELLIGENCE_ENVIRONMENT, {
      event: "si_request",
      request_id: requestId,
      path: url.pathname,
      status: response.status,
      latency_ms: Date.now() - started,
    });
    return response;
  } catch (error) {
    incrementCounter("service_binding_failures");
    if (error instanceof DomainValidationError) {
      // A validation failure is the caller's, and its message is safe: it was
      // authored here, never derived from provider or driver output.
      return badRequest(error.code, error.message);
    }
    log("error", config.SEARCH_INTELLIGENCE_ENVIRONMENT, {
      event: "si_request_failed",
      request_id: requestId,
      path: url.pathname,
      status: 500,
      latency_ms: Date.now() - started,
      error_code: "HANDLER_FAILED",
    });
    // Never propagate the cause: it can carry a binding name or driver text.
    return json({ error: "internal error" }, 500);
  }
}
