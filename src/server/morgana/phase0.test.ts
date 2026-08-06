import { describe, expect, it, beforeEach, vi } from "vitest";
import { phase0EnvSchema, readPhase0Config, isEnabled } from "./phase0-env";
import {
  checkPaidCall,
  assertPaidCallAllowed,
  detectMeteredWhileDisabled,
  PAID_CALLS_DISABLED_REASON,
  ZERO_CAP_REASON,
} from "./phase0-guard";
import {
  buildCostLedger,
  resolveDataForSeoStatus,
  SEARCH_INTELLIGENCE_COST_CENTRE,
  BRAND_MONITORING_COST_CENTRE,
  ZERO_USAGE,
} from "./phase0-cost";
import { redact, redactHeaders, resetCounters } from "./phase0-logging";
import { handlePhase0Request, PHASE0_PATHS } from "./phase0-routes";

/**
 * Morgana Search Intelligence — Phase 0 tests.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P4).
 *
 * These assert the guarantees Phase 0 is accountable for: the engine cannot
 * spend, cannot leak a credential into a log, cannot serve a capability that
 * is supposed to be off, and reports a truthful posture.
 */

const PHASE0_VARS = {
  SEARCH_INTELLIGENCE_ENABLED: "false",
  SEARCH_INTELLIGENCE_STAGING_ENABLED: "true",
  SEARCH_INTELLIGENCE_UI_ENABLED: "false",
  SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "false",
  SEARCH_INTELLIGENCE_MCP_ENABLED: "false",
  SEARCH_INTELLIGENCE_AI_ENABLED: "false",
  SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED: "false",
  SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0",
  SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "0",
  SEARCH_INTELLIGENCE_ENVIRONMENT: "staging",
  AUTH_MODE: "cloudflare_access",
};

function parse(overrides: Record<string, string> = {}) {
  return phase0EnvSchema.parse({ ...PHASE0_VARS, ...overrides });
}

beforeEach(() => {
  resetCounters();
  // getEnvValueSync consults process.env first; keep it out of these cases.
  vi.unstubAllEnvs();
});

/**
 * Parse a JSON body without asserting its shape. The engine returns unknown by
 * contract, so the tests read it through an index rather than claiming a type
 * the response has not been checked against.
 */
async function readBody(
  response: Response | null | undefined,
): Promise<Record<string, unknown>> {
  const body: unknown = await response?.json();
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? Object.fromEntries(Object.entries(body))
    : {};
}

describe("phase 0 configuration", () => {
  it("defaults every capability to off", () => {
    const config = phase0EnvSchema.parse({});
    expect(isEnabled(config.SEARCH_INTELLIGENCE_ENABLED)).toBe(false);
    expect(isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED)).toBe(
      false,
    );
    expect(isEnabled(config.SEARCH_INTELLIGENCE_MCP_ENABLED)).toBe(false);
    expect(isEnabled(config.SEARCH_INTELLIGENCE_AI_ENABLED)).toBe(false);
    expect(isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED)).toBe(
      false,
    );
    expect(isEnabled(config.SEARCH_INTELLIGENCE_UI_ENABLED)).toBe(false);
  });

  it("defaults both cost caps to zero, so an absent cap cannot mean unlimited", () => {
    const config = phase0EnvSchema.parse({});
    expect(config.SEO_DATAFORSEO_DAILY_COST_CAP_USD).toBe(0);
    expect(config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD).toBe(0);
  });

  it("parses USD caps into integer micro-USD without floating point drift", () => {
    const config = parse({
      SEARCH_INTELLIGENCE_ENABLED: "true",
      SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
      SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
      SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2",
    });
    expect(config.SEO_DATAFORSEO_DAILY_COST_CAP_USD).toBe(200_000);
    expect(config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD).toBe(2_000_000);
    expect(Number.isInteger(config.SEO_DATAFORSEO_DAILY_COST_CAP_USD)).toBe(
      true,
    );
  });

  // This is the brief's "the build must fail if a paid feature is enabled with
  // a zero budget" requirement, enforced at the last possible moment.
  it("refuses to boot when paid calls are enabled against a zero daily cap", () => {
    expect(() =>
      parse({
        SEARCH_INTELLIGENCE_ENABLED: "true",
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
        SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2",
      }),
    ).toThrow(/greater than zero/);
  });

  it("refuses to boot when paid calls are enabled against a zero monthly cap", () => {
    expect(() =>
      parse({
        SEARCH_INTELLIGENCE_ENABLED: "true",
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
        SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
      }),
    ).toThrow(/greater than zero/);
  });

  it("refuses to boot when paid calls are enabled but the engine is not", () => {
    expect(() =>
      parse({
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
        SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
        SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2",
      }),
    ).toThrow(/requires SEARCH_INTELLIGENCE_ENABLED=true/);
  });

  it("rejects a daily cap larger than the monthly cap", () => {
    expect(() =>
      parse({
        SEO_DATAFORSEO_DAILY_COST_CAP_USD: "5",
        SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2",
      }),
    ).toThrow(/must not exceed/);
  });

  it("rejects a negative or malformed cap rather than coercing it", () => {
    expect(() => parse({ SEO_DATAFORSEO_DAILY_COST_CAP_USD: "-1" })).toThrow();
    expect(() =>
      parse({ SEO_DATAFORSEO_DAILY_COST_CAP_USD: "lots" }),
    ).toThrow();
  });

  it("reads configuration from a Workers-style env object", () => {
    const config = readPhase0Config({ ...PHASE0_VARS });
    expect(config.SEARCH_INTELLIGENCE_ENVIRONMENT).toBe("staging");
    expect(config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD).toBe(0);
  });
});

describe("paid-call guard", () => {
  it("blocks every billable call while paid calls are disabled", () => {
    const decision = checkPaidCall(parse());
    expect(decision).toEqual({
      allowed: false,
      reason: PAID_CALLS_DISABLED_REASON,
    });
  });

  // The caps are evaluated independently of the flag on purpose: this is what
  // makes "caps are zero" a control rather than a comment.
  it("still blocks when the flag is on but a cap is zero", () => {
    // Bypass schema validation to simulate a config that reached runtime.
    const config = {
      ...parse(),
      SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true" as const,
    };
    expect(checkPaidCall(config)).toEqual({
      allowed: false,
      reason: ZERO_CAP_REASON,
    });
  });

  it("allows a call only when the flag is on and both caps are positive", () => {
    const config = parse({
      SEARCH_INTELLIGENCE_ENABLED: "true",
      SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
      SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
      SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2",
    });
    expect(checkPaidCall(config)).toEqual({ allowed: true });
  });

  it("throws and counts a block when a billable operation is attempted", () => {
    expect(() => assertPaidCallAllowed(parse(), "serp.task_post")).toThrow(
      /Blocked billable operation/,
    );
  });

  it("flags metered requests while paid calls are off as a critical incident", () => {
    expect(detectMeteredWhileDisabled(parse(), 0)).toBe(false);
    expect(detectMeteredWhileDisabled(parse(), 1)).toBe(true);
  });
});

describe("cost centre", () => {
  it("is separate from Brand Monitoring", () => {
    expect(SEARCH_INTELLIGENCE_COST_CENTRE).toBe(
      "dataforseo_search_intelligence",
    );
    expect(BRAND_MONITORING_COST_CENTRE).toBe("dataforseo_brand_monitoring");
    expect(SEARCH_INTELLIGENCE_COST_CENTRE).not.toBe(
      BRAND_MONITORING_COST_CENTRE,
    );
  });

  it("reports a zeroed ledger with every required field in Phase 0", () => {
    const ledger = buildCostLedger(parse());
    expect(ledger).toMatchObject({
      cost_centre: SEARCH_INTELLIGENCE_COST_CENTRE,
      requests: 0,
      metered_requests: 0,
      free_requests: 0,
      paid_submissions: 0,
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      daily_cost_cap_usd: 0,
      monthly_cost_cap_usd: 0,
      budget_remaining_usd: 0,
      projected_month_end_cost_usd: 0,
      cache_hits: 0,
      cache_misses: 0,
      blocked_by_budget: 0,
      unexpected_spend_detected: false,
    });
  });

  it("derives free requests as the non-metered remainder", () => {
    const ledger = buildCostLedger(parse(), {
      ...ZERO_USAGE,
      requests: 10,
      meteredRequests: 3,
    });
    // Free polls must never ration paid work — Morgana decision #84.
    expect(ledger.free_requests).toBe(7);
  });

  it("projects month-end spend from the elapsed portion of the month", () => {
    const ledger = buildCostLedger(
      parse({
        SEARCH_INTELLIGENCE_ENABLED: "true",
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
        SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
        SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2",
      }),
      { ...ZERO_USAGE, actualCostMicros: 500_000 },
      new Date("2026-08-10T00:00:00Z"),
    );
    // $0.50 spent over 10 of 31 days projects to $1.55.
    expect(ledger.projected_month_end_cost_usd).toBeCloseTo(1.55, 2);
    expect(ledger.budget_remaining_usd).toBeCloseTo(1.5, 2);
  });

  it("treats an absent dedicated credential as not_configured, not an error", () => {
    const enabled = parse({ SEARCH_INTELLIGENCE_ENABLED: "true" });
    expect(resolveDataForSeoStatus(enabled, false)).toBe("not_configured");
    expect(resolveDataForSeoStatus(enabled, true)).toBe(
      "configured_but_paid_calls_disabled",
    );
    expect(resolveDataForSeoStatus(parse(), true)).toBe("disabled");
  });
});

describe("log redaction", () => {
  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl";
    expect(redact(`token=${jwt}`)).toBe("token=[redacted-jwt]");
  });

  it("redacts an email address", () => {
    expect(redact("user person@example.com denied")).toBe(
      "user [redacted-email] denied",
    );
  });

  it("redacts a long opaque token such as a base64 credential", () => {
    // A DataForSEO key is base64("login:password"). The fixture is built at
    // runtime from obviously fake input rather than pasted as a literal, so no
    // string in this repository ever looks like a real credential to a secret
    // scanner — the pre-commit hook is right to reject those on sight.
    const fakeKey = btoa(`fake-login:${"not-a-real-password".repeat(2)}`);
    expect(redact(`key=${fakeKey}`)).toBe("key=[redacted]");
  });

  it("redacts credential-bearing headers by name", () => {
    const headers = new Headers({
      authorization: "Bearer secret-value",
      cookie: "CF_Authorization=abc",
      "cf-access-jwt-assertion": "assertion",
      "content-type": "application/json",
    });
    const safe = redactHeaders(headers);
    expect(safe.authorization).toBe("[redacted]");
    expect(safe.cookie).toBe("[redacted]");
    expect(safe["cf-access-jwt-assertion"]).toBe("[redacted]");
    // Non-sensitive headers survive, or the log stops being useful.
    expect(safe["content-type"]).toBe("application/json");
  });
});

describe("contract endpoints", () => {
  const env = { ...PHASE0_VARS };

  it("serves exactly three paths and nothing else", () => {
    expect(Array.from(PHASE0_PATHS).toSorted()).toEqual([
      "/healthz",
      "/internal/status",
      "/readyz",
    ]);
  });

  it("returns null for an unrelated path, leaving upstream routing untouched", async () => {
    const response = await handlePhase0Request(
      new Request("https://engine.internal/dashboard"),
      env,
    );
    expect(response).toBeNull();
  });

  it("answers /healthz without touching any binding", async () => {
    const response = await handlePhase0Request(
      new Request("https://engine.internal/healthz"),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      status: "ok",
      service: "morgana-search-intelligence",
      environment: "staging",
    });
  });

  it("reports the Phase-0 posture on /internal/status", async () => {
    const response = await handlePhase0Request(
      new Request("https://engine.internal/internal/status"),
      { ...env, ENGINE_UPSTREAM_RELEASE: "v0.1.3" },
    );
    const body = await readBody(response);
    expect(body.paid_calls_enabled).toBe(false);
    expect(body.mcp_enabled).toBe(false);
    expect(body.ai_enabled).toBe(false);
    expect(body.site_audit_enabled).toBe(false);
    expect(body.daily_cost_cap_usd).toBe(0);
    expect(body.monthly_cost_cap_usd).toBe(0);
    expect(body.dataforseo_status).toBe("disabled");
    expect(body.upstream_release).toBe("v0.1.3");
    expect(body.marker).toBe("Morgana Search Intelligence — STAGING");
  });

  it("never exposes a secret, a full resource id or an email in the status payload", async () => {
    // Built at runtime, never a literal — see the redaction test above.
    const fakeKey = btoa("fake-login:fake-password-value");
    const response = await handlePhase0Request(
      new Request("https://engine.internal/internal/status"),
      {
        ...env,
        DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY: fakeKey,
        ENGINE_D1_ID: "0bce5159-d388-4d0e-8213-aa96803d37f9",
      },
    );
    const text = await response?.text();
    expect(text).not.toContain(fakeKey);
    // The id is truncated to a correlation prefix, never emitted in full.
    expect(text).not.toContain("0bce5159-d388-4d0e-8213-aa96803d37f9");
    expect(text).toContain("0bce5159…");
  });

  it("rejects a non-GET request", async () => {
    const response = await handlePhase0Request(
      new Request("https://engine.internal/healthz", { method: "POST" }),
      env,
    );
    expect(response?.status).toBe(405);
  });

  it("fails closed with no detail when the spend configuration is invalid", async () => {
    const response = await handlePhase0Request(
      new Request("https://engine.internal/healthz"),
      { ...env, SEO_DATAFORSEO_DAILY_COST_CAP_USD: "not-a-number" },
    );
    expect(response?.status).toBe(500);
    const body = await readBody(response);
    expect(body.error).toBe("invalid engine configuration");
    // The failing variable name must not leak to the caller.
    expect(JSON.stringify(body)).not.toContain("SEO_DATAFORSEO");
  });

  /**
   * The spend posture asks whether spending is BOUNDED, not whether it is
   * impossible.
   *
   * It used to ask the latter — paid calls off and both caps zero — which was
   * right when the engine had no budget and no credential. It became wrong the
   * moment production had a real one, because it made "funded within a cap"
   * indistinguishable from "misconfigured" and would have reported a correctly
   * configured production engine as `not_ready` with a 503.
   */
  async function spendPosture(
    overrides: Record<string, string>,
  ): Promise<{ status: number | undefined; posture: unknown }> {
    const response = await handlePhase0Request(
      new Request("https://engine.internal/readyz"),
      { ...env, ...overrides },
    );
    const body = await readBody(response);
    const checks = Object.fromEntries(Object.entries(body.checks ?? {}));
    return { status: response?.status, posture: checks.spend_posture };
  }

  it("never reaches readyz at all when paid calls are on with no cap", async () => {
    // Env validation refuses that pair at boot, so the engine fails closed with
    // no checks rather than serving a degraded readiness. Two independent
    // controls on the same risk, and this asserts the FIRST one still fires —
    // which is why the readyz rule below can afford to be about coherence.
    const { status, posture } = await spendPosture({
      SEARCH_INTELLIGENCE_ENABLED: "true",
      SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
      SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0",
      SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "0",
    });
    expect(status).toBe(500);
    expect(posture).toBeUndefined();
  });

  it("is ok when paid calls are funded within coherent caps", async () => {
    // The real production posture at activation.
    expect(
      await spendPosture({
        SEARCH_INTELLIGENCE_ENABLED: "true",
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
        SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
        SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2",
      }),
    ).toMatchObject({ posture: "ok" });
  });

  it("is ok with paid calls off, whatever the caps say", async () => {
    // Nothing can spend, so the caps are irrelevant to safety.
    expect(
      await spendPosture({
        SEARCH_INTELLIGENCE_ENABLED: "true",
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "false",
        SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0",
        SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "0",
      }),
    ).toMatchObject({ posture: "ok" });
  });
});
