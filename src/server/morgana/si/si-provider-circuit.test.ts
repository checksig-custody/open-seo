import { describe, expect, it } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  classifyProviderAccountEvent,
  isLatched,
  sanitizeProviderMessage,
} from "./provider-events";
import { alertDryRun, routeFinding, type AlertFinding } from "./alert-dry-run";
import { readPhase0Config } from "../phase0-env";

/**
 * The classification is pure, and these tests are the reason it is.
 *
 * A wrong `account_suspended` stops every collector in the subsystem; a missed
 * one keeps billing a suspended account until somebody notices. Neither failure
 * is visible from a passing integration test, so the mapping is pinned here
 * exhaustively — including the codes that must map to NOTHING.
 */
function dataforseoError(statusCode: number, message = "denied"): AppError {
  return new AppError("INTERNAL_ERROR", message, {
    dataforseoStatusCode: String(statusCode),
  });
}

describe("DataForSEO account-event classification", () => {
  it("latches 40201 as an account suspension", () => {
    const event = classifyProviderAccountEvent(dataforseoError(40201));
    expect(event.kind).toBe("account_suspended");
    expect(event.statusCode).toBe(40201);
    expect(isLatched("account_suspended")).toBe(true);
  });

  it("does NOT latch 40202 — a rate limit is not a suspension", () => {
    // The whole point of the distinction. Latching this would turn a busy
    // minute into a permanent outage that only a human could clear.
    const event = classifyProviderAccountEvent(dataforseoError(40202));
    expect(event.kind).toBe("rate_limited");
  });

  it("treats the 401xx family as an authentication failure", () => {
    expect(classifyProviderAccountEvent(dataforseoError(40100)).kind).toBe(
      "auth_failed",
    );
    expect(
      classifyProviderAccountEvent({ code: "DATAFORSEO_AUTH_FAILED" }).kind,
    ).toBe("auth_failed");
  });

  it("treats the rest of the 402xx family as an unentitled account", () => {
    expect(classifyProviderAccountEvent(dataforseoError(40203)).kind).toBe(
      "account_not_enabled",
    );
  });

  it("says NOTHING about the account for unrelated failures", () => {
    // Silence is the correct answer here. Guessing that an unrecognised error
    // is an account event is how a subsystem latches itself on a hiccup — the
    // same class of over-claiming that once recorded three healthy SERPs as
    // provider failures.
    expect(classifyProviderAccountEvent(new Error("socket hang up")).kind).toBe(
      "none",
    );
    expect(classifyProviderAccountEvent(dataforseoError(20000)).kind).toBe(
      "none",
    );
    expect(classifyProviderAccountEvent(null).kind).toBe("none");
  });

  it("never lets a credential into the stored message", () => {
    const message = sanitizeProviderMessage(
      "auth failed for https://user:pw@api.dataforseo.com/v3 with " +
        "Basic bG9naW5AZXhhbXBsZS5jb206c3VwZXJzZWNyZXQ= (mail ops@example.com)",
    );
    expect(message).not.toContain("dataforseo.com");
    expect(message).not.toContain("bG9naW5AZXhhbXBsZS5jb20");
    expect(message).not.toContain("ops@example.com");
    expect(message).toContain("[url]");
  });
});

// Parsed, not cast. `readPhase0Config` enforces the dependency that an alert
// flag cannot be on while its feature is off, so a hand-built object would be
// asserting a configuration the engine would refuse to boot with.
const config = readPhase0Config({
  SEARCH_INTELLIGENCE_ENABLED: "true",
  SEARCH_INTELLIGENCE_AI_VISIBILITY_ALERTS_ENABLED: "false",
  SEARCH_INTELLIGENCE_SITE_AUDIT_ALERTS_ENABLED: "false",
});

const alertsOn = readPhase0Config({
  SEARCH_INTELLIGENCE_ENABLED: "true",
  SEARCH_INTELLIGENCE_AI_VISIBILITY_ENABLED: "true",
  SEARCH_INTELLIGENCE_AI_VISIBILITY_ALERTS_ENABLED: "true",
  SEARCH_INTELLIGENCE_SITE_AUDIT_ALERTS_ENABLED: "false",
});

function finding(overrides: Partial<AlertFinding> = {}): AlertFinding {
  return {
    kind: "ranking_change",
    title: "checksig moved to position 1",
    summary: "up four places",
    risk: "low",
    signalFamilies: ["ranking"],
    ...overrides,
  };
}

describe("alert routing", () => {
  it("sends ordinary SEO findings to intel", () => {
    expect(routeFinding(finding())).toBe("intel");
    expect(routeFinding(finding({ kind: "backlink_change" }))).toBe("intel");
    expect(routeFinding(finding({ kind: "reputation" }))).toBe("intel");
  });

  it("sends impersonation and brand confusion to brand protection", () => {
    expect(routeFinding(finding({ kind: "impersonation" }))).toBe(
      "brand_protection",
    );
    expect(routeFinding(finding({ kind: "suspicious_domain" }))).toBe(
      "brand_protection",
    );
  });

  it("requires high risk AND two independent families for security", () => {
    // One signal shouting loudly is not corroboration, however sure it is.
    expect(
      routeFinding(
        finding({
          kind: "impersonation",
          risk: "high",
          signalFamilies: ["content"],
        }),
      ),
    ).toBe("brand_protection");
    expect(
      routeFinding(
        finding({
          kind: "impersonation",
          risk: "high",
          signalFamilies: ["content", "domain_registration"],
        }),
      ),
    ).toBe("security");
  });

  it("counts DISTINCT families, so one signal listed twice is still one", () => {
    expect(
      routeFinding(
        finding({
          kind: "impersonation",
          risk: "high",
          signalFamilies: ["content", "content"],
        }),
      ),
    ).toBe("brand_protection");
  });
});

describe("the alert dry run", () => {
  it("suppresses everything while the master switch is off, and says so", () => {
    const result = alertDryRun(config, finding(), { intel: "configured" });
    expect(result.wouldDeliver).toBe(false);
    // The master switch is named rather than the deeper cause: reporting a
    // webhook problem here would send someone to fix the wrong thing.
    expect(result.suppressionReason).toBe("alerts_disabled");
    expect(result.networkCallsMade).toBe(0);
  });

  it("reports an invalid webhook distinctly from an absent one", () => {
    expect(
      alertDryRun(alertsOn, finding(), {
        intel: "webhook_invalid_configuration",
      }).suppressionReason,
    ).toBe("webhook_invalid_configuration");
    expect(
      alertDryRun(alertsOn, finding(), { intel: "webhook_not_configured" })
        .suppressionReason,
    ).toBe("webhook_not_configured");
  });

  it("suppresses an UNKNOWN channel rather than assuming it works", () => {
    expect(alertDryRun(alertsOn, finding(), {}).wouldDeliver).toBe(false);
  });

  it("never reroutes: a broken channel suppresses, it does not fall back", () => {
    const result = alertDryRun(alertsOn, finding({ kind: "impersonation" }), {
      brand_protection: "webhook_invalid_configuration",
      intel: "configured",
    });
    // The intel channel is healthy and is NOT used. A brand-protection warning
    // delivered to the SEO channel is a misfiled security signal, not a
    // degraded success.
    expect(result.channel).toBe("brand_protection");
    expect(result.wouldDeliver).toBe(false);
  });

  it("would deliver once the channel is configured and alerts are on", () => {
    const result = alertDryRun(alertsOn, finding(), { intel: "configured" });
    expect(result.wouldDeliver).toBe(true);
    expect(result.suppressionReason).toBeNull();
    expect(result.payload.channel).toBe("intel");
  });
});
