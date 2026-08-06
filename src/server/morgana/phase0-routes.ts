import { getEnvValueSync } from "@/server/lib/runtime-env";
import { type Phase0Config, isEnabled, readPhase0Config } from "./phase0-env";
import { buildCostLedger, resolveDataForSeoStatus } from "./phase0-cost";
import {
  incrementCounter,
  log,
  requestIdFor,
  readCounters,
} from "./phase0-logging";

/**
 * Morgana Search Intelligence — Phase 0 contract endpoints.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P2).
 *
 * `/healthz`, `/readyz` and `/internal/status` are the entire Phase-0 surface.
 * They are the only paths Morgana calls, and they are reachable ONLY over the
 * Cloudflare Service Binding: the staging Worker is deployed with no route and
 * `workers_dev: false`, so it has no public ingress whatsoever.
 *
 * They are intentionally handled before upstream's own dispatch — including
 * before the self-host telemetry heartbeat — so a health probe performs no work
 * beyond what it reports on.
 *
 * Nothing here emits a token, a secret, a full resource id, a bucket name, a
 * user email or a stack trace.
 */

export const PHASE0_PATHS = new Set([
  "/healthz",
  "/readyz",
  "/internal/status",
]);

const STAGING_MARKER = "Morgana Search Intelligence — STAGING";
const SERVICE_NAME = "morgana-search-intelligence";

/** Show enough of an id to correlate, never enough to identify a resource. */
function idPrefix(value: string | undefined): string {
  if (!value) return "unset";
  return `${value.slice(0, 8)}…`;
}

type CheckStatus = "ok" | "degraded" | "unavailable" | "not_provisioned";

type Bindings = {
  DB?: { prepare: (query: string) => { first: () => Promise<unknown> } };
  KV?: { get: (key: string) => Promise<string | null> };
  R2?: { head: (key: string) => Promise<unknown> };
};

async function checkD1(env: Bindings): Promise<CheckStatus> {
  if (!env.DB) return "not_provisioned";
  try {
    await env.DB.prepare("SELECT 1").first();
    return "ok";
  } catch {
    incrementCounter("d1_errors");
    return "unavailable";
  }
}

/**
 * Migrations are considered applied when a table the upstream schema creates is
 * queryable. This deliberately probes the schema rather than the migrations
 * table: an empty `d1_migrations` with a populated schema, or the reverse, both
 * mean "not ready" and only the schema probe catches the second case.
 */
async function checkMigrations(env: Bindings): Promise<CheckStatus> {
  if (!env.DB) return "not_provisioned";
  try {
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'",
    ).first();
    return "ok";
  } catch {
    incrementCounter("d1_errors");
    return "unavailable";
  }
}

async function checkKv(env: Bindings): Promise<CheckStatus> {
  if (!env.KV) return "not_provisioned";
  try {
    await env.KV.get("__morgana_readyz_probe");
    return "ok";
  } catch {
    incrementCounter("kv_errors");
    return "unavailable";
  }
}

async function checkR2(env: Bindings): Promise<CheckStatus> {
  if (!env.R2) return "not_provisioned";
  try {
    await env.R2.head("__morgana_readyz_probe");
    return "ok";
  } catch {
    incrementCounter("r2_errors");
    return "unavailable";
  }
}

function credentialPresent(env: object): boolean {
  return Boolean(
    getEnvValueSync(env, "DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY") ??
    getEnvValueSync(env, "DATAFORSEO_API_KEY"),
  );
}

/**
 * Every capability the brief requires to stay off in Phase 0, reported as data
 * so a test and a reviewer read the same list.
 */
function capabilities(config: Phase0Config) {
  return {
    search_intelligence: isEnabled(config.SEARCH_INTELLIGENCE_ENABLED),
    ui: isEnabled(config.SEARCH_INTELLIGENCE_UI_ENABLED),
    paid_calls: isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED),
    mcp: isEnabled(config.SEARCH_INTELLIGENCE_MCP_ENABLED),
    ai: isEnabled(config.SEARCH_INTELLIGENCE_AI_ENABLED),
    site_audit: isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED),
    // Phase 5. Reported separately from `site_audit` because they are not the
    // same decision: the feature flag says the surface exists, the scheduler
    // says we crawl someone's server without being asked, and the live provider
    // is the only phase-5 switch that can spend money.
    site_audit_scheduler: isEnabled(
      config.SEARCH_INTELLIGENCE_SITE_AUDIT_SCHEDULER_ENABLED,
    ),
    site_audit_alerts: isEnabled(
      config.SEARCH_INTELLIGENCE_SITE_AUDIT_ALERTS_ENABLED,
    ),
    ai_visibility: isEnabled(config.SEARCH_INTELLIGENCE_AI_VISIBILITY_ENABLED),
    ai_visibility_alerts: isEnabled(
      config.SEARCH_INTELLIGENCE_AI_VISIBILITY_ALERTS_ENABLED,
    ),
    ai_visibility_live_provider: isEnabled(
      config.SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED,
    ),
    // Phase 0 exposes no SEO capability at all; these are named so the Phase-1
    // reader sees an explicit false rather than an absent key.
    domain_overview: false,
    keyword_research: false,
    rank_tracking: false,
    backlinks: false,
    scheduled_seo_jobs: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // The engine renders nothing and is called machine-to-machine only.
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

async function handleReadyz(
  config: Phase0Config,
  env: object,
): Promise<Response> {
  const bindings = env as Bindings;
  const [database, migrations, kv, r2] = await Promise.all([
    checkD1(bindings),
    checkMigrations(bindings),
    checkKv(bindings),
    checkR2(bindings),
  ]);

  const dataforseo = resolveDataForSeoStatus(config, credentialPresent(env));
  const paidCallsOff = !isEnabled(
    config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED,
  );
  const capsAreZero =
    config.SEO_DATAFORSEO_DAILY_COST_CAP_USD === 0 &&
    config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD === 0;

  const checks = {
    database,
    migrations,
    kv,
    r2,
    // Auth is "configured" when the engine is fail-closed. Phase 0 runs with
    // AUTH_MODE=cloudflare_access and no TEAM_DOMAIN/POLICY_AUD, which makes
    // every application route reject — the intended posture, not a fault.
    auth: getEnvValueSync(env, "AUTH_MODE") ? "ok" : "degraded",
    // The spend posture is part of readiness: a staging engine that could spend
    // is not ready, however healthy its bindings are.
    spend_posture: paidCallsOff && capsAreZero ? "ok" : "degraded",
    dataforseo,
  } as const;

  // A missing R2 bucket is a documented, tolerated Phase-0 outcome (bucket
  // creation was not guaranteed by the available token scopes), so
  // `not_provisioned` degrades rather than fails. DataForSEO never fails
  // readiness in Phase 0 by design.
  const blocking: CheckStatus[] = [database, migrations, kv];
  const ready =
    !blocking.includes("unavailable") &&
    !blocking.includes("not_provisioned") &&
    checks.spend_posture === "ok";

  if (!ready) {
    incrementCounter("readiness_failures");
  }

  return jsonResponse(
    {
      status: ready ? "ready" : "not_ready",
      service: SERVICE_NAME,
      environment: config.SEARCH_INTELLIGENCE_ENVIRONMENT,
      marker: STAGING_MARKER,
      checks,
    },
    ready ? 200 : 503,
  );
}

function handleStatus(config: Phase0Config, env: object): Response {
  const dataforseo = resolveDataForSeoStatus(config, credentialPresent(env));
  const ledger = buildCostLedger(config);

  return jsonResponse({
    service: SERVICE_NAME,
    environment: config.SEARCH_INTELLIGENCE_ENVIRONMENT,
    marker: STAGING_MARKER,
    status: ledger.unexpected_spend_detected ? "critical" : "ok",
    api_version: config.SEARCH_INTELLIGENCE_API_VERSION,
    engine_version: config.ENGINE_UPSTREAM_RELEASE,
    upstream_repository: config.ENGINE_UPSTREAM_REPOSITORY,
    upstream_release: config.ENGINE_UPSTREAM_RELEASE,
    upstream_commit: config.ENGINE_UPSTREAM_COMMIT,
    local_commit: config.ENGINE_LOCAL_COMMIT,
    auth_mode: getEnvValueSync(env, "AUTH_MODE") ?? "unset",
    // Truncated on purpose: enough to confirm which database is bound, never
    // enough to address it.
    database_status: env && "DB" in env ? "bound" : "unbound",
    database_id_prefix: idPrefix(getEnvValueSync(env, "ENGINE_D1_ID")),
    r2_status: env && "R2" in env ? "bound" : "unbound",
    kv_status: env && "KV" in env ? "bound" : "unbound",
    dataforseo_status: dataforseo,
    paid_calls_enabled: isEnabled(
      config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED,
    ),
    daily_cost_cap_usd: ledger.daily_cost_cap_usd,
    monthly_cost_cap_usd: ledger.monthly_cost_cap_usd,
    mcp_enabled: isEnabled(config.SEARCH_INTELLIGENCE_MCP_ENABLED),
    ai_enabled: isEnabled(config.SEARCH_INTELLIGENCE_AI_ENABLED),
    site_audit_enabled: isEnabled(
      config.SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED,
    ),
    capabilities: capabilities(config),
    cost: ledger,
    counters: readCounters(),
    last_deploy_at: config.ENGINE_DEPLOYED_AT,
    checked_at: new Date().toISOString(),
  });
}

/**
 * Entry point patched into `src/server.ts`. Returns null for any path that is
 * not part of the Phase-0 contract, so upstream routing is untouched.
 */
export async function handlePhase0Request(
  request: Request,
  env: object,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;

  // MORGANA LOCAL PATCH (UPSTREAM.md, patch P6). Phase-1 Search Intelligence
  // shares this private surface: same "no public ingress, Service Binding only"
  // reachability, same fail-closed posture. It is dispatched here rather than
  // in `src/server.ts` so the engine has exactly one private entry point.
  //
  // The import is DYNAMIC on purpose. A static one would pull the Drizzle/D1
  // layer — and therefore `cloudflare:workers` — into this module's eager
  // graph, which both breaks the Node-side Phase-0 tests and would make
  // `/healthz` load the database stack it is explicitly supposed not to touch.
  if (pathname.startsWith("/internal/si/")) {
    const { handleSearchIntelligenceRequest } = await import("./si/api");
    const response = await handleSearchIntelligenceRequest(request, env);
    if (response) return response;
  }

  if (!PHASE0_PATHS.has(pathname)) {
    return null;
  }

  const started = Date.now();
  const requestId = requestIdFor(request);
  incrementCounter("service_binding_requests");

  let config: Phase0Config;
  try {
    config = readPhase0Config(env);
  } catch {
    // Invalid Phase-0 configuration means the spend posture is unknown. Fail
    // closed and say nothing about which value was wrong.
    incrementCounter("service_binding_failures");
    log("error", "unknown", {
      event: "phase0_config_invalid",
      request_id: requestId,
      status: 500,
      error_code: "CONFIG_INVALID",
    });
    return jsonResponse(
      { status: "error", error: "invalid engine configuration" },
      500,
    );
  }

  if (request.method !== "GET") {
    return jsonResponse({ status: "error", error: "method not allowed" }, 405);
  }

  try {
    let response: Response;
    if (pathname === "/healthz") {
      incrementCounter("health_requests");
      response = jsonResponse({
        status: "ok",
        service: SERVICE_NAME,
        environment: config.SEARCH_INTELLIGENCE_ENVIRONMENT,
      });
    } else if (pathname === "/readyz") {
      response = await handleReadyz(config, env);
    } else {
      response = handleStatus(config, env);
    }

    log("info", config.SEARCH_INTELLIGENCE_ENVIRONMENT, {
      event: "phase0_request",
      request_id: requestId,
      trace_id: request.headers.get("cf-ray") ?? undefined,
      path: pathname,
      status: response.status,
      latency_ms: Date.now() - started,
    });
    return response;
  } catch {
    // Never propagate an exception body: it can carry a binding name or a
    // driver message. The detail stays in the counter and the log event.
    incrementCounter("service_binding_failures");
    if (pathname === "/healthz") {
      incrementCounter("health_failures");
    }
    log("error", config.SEARCH_INTELLIGENCE_ENVIRONMENT, {
      event: "phase0_request_failed",
      request_id: requestId,
      path: pathname,
      status: 500,
      latency_ms: Date.now() - started,
      error_code: "HANDLER_FAILED",
    });
    return jsonResponse({ status: "error", error: "internal error" }, 500);
  }
}
