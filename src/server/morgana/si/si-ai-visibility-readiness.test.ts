import { describe, expect, it } from "vitest";
import {
  aiVisibilityReadiness,
  engineCapabilities,
} from "./ai-visibility-capabilities";
import { readPhase0Config } from "../phase0-env";

/**
 * Morgana Search Intelligence — AI Visibility readiness.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P15).
 *
 * The failure this guards against is a subsystem that claims coverage it does
 * not have. A UI tab is not evidence, a fixture is not an observation, and an
 * endpoint existing in a client is not the same as this account being allowed
 * to call it. Each of those is a separate status, and the tests below exist to
 * keep them separate.
 */

const baseEnv = {
  SEARCH_INTELLIGENCE_ENABLED: "true",
  SEARCH_INTELLIGENCE_ENVIRONMENT: "production",
  SEARCH_INTELLIGENCE_AI_VISIBILITY_ENABLED: "true",
  SEO_DATAFORSEO_DAILY_COST_CAP_USD: "0.20",
  SEO_DATAFORSEO_MONTHLY_COST_CAP_USD: "2.00",
};

describe("capability discovery", () => {
  it("rests every claim on a symbol in this repository", () => {
    for (const capability of engineCapabilities()) {
      if (capability.status === "unsupported") {
        expect(capability.evidence).toBeNull();
        continue;
      }
      // Anything claimed as reachable names the client function behind it, so
      // the claim can be checked by reading one file.
      expect(capability.evidence).toMatch(/server\/lib\/dataforseo/);
    }
  });

  it("mirrors the model catalogue the client already validates", () => {
    const byEngine = new Map(
      engineCapabilities().map((c) => [c.engine, c.models]),
    );
    expect(byEngine.get("chat_gpt")).toEqual(["gpt-5"]);
    expect(byEngine.get("perplexity")).toContain("sonar-pro");
    // A model outside these sets is rejected before a request is made, so the
    // list is a contract rather than documentation.
    expect(byEngine.get("gemini")).toEqual(["gemini-2.5-pro"]);
  });

  it("calls an engine with no endpoint unsupported, not merely unconfigured", () => {
    const copilot = engineCapabilities().find(
      (c) => c.engine === "bing_copilot",
    );
    expect(copilot?.status).toBe("unsupported");
  });

  it("does not claim Google AI Overview is collectable just because it is modelled", () => {
    const overview = engineCapabilities().find(
      (c) => c.engine === "google_ai_overview",
    );
    // The item type exists in the typing; no collector reads it. Saying
    // "supported" here would be the UI-is-evidence mistake.
    expect(overview?.status).toBe("capability_unknown");
  });

  it("never claims entitlement it cannot know without spending", () => {
    const llm = engineCapabilities().filter((c) => c.surface === "llm_answer");
    const claimedSupported = llm.filter((c) => c.status === "supported");
    // Whether THIS account may call AI Optimization is only knowable from a
    // billable call, and this session makes none.
    expect(claimedSupported).toHaveLength(0);
  });
});

describe("readiness", () => {
  it("says not_configured when the local switches are off, not unsupported", () => {
    const readiness = aiVisibilityReadiness(readPhase0Config(baseEnv), true);
    expect(readiness.status).toBe("not_configured");
    // A reader who cannot tell a local switch from a provider limitation goes
    // and fixes the wrong thing.
    expect(readiness.reason).toContain("switch is off");
  });

  it("says not_configured when the credential is missing", () => {
    const readiness = aiVisibilityReadiness(
      readPhase0Config({
        ...baseEnv,
        SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED: "true",
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
      }),
      false,
    );
    expect(readiness.status).toBe("not_configured");
    expect(readiness.reason).toContain("credential");
  });

  it("reaches paid_verification_required only with everything switched on", () => {
    const readiness = aiVisibilityReadiness(
      readPhase0Config({
        ...baseEnv,
        SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED: "true",
        SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "true",
      }),
      true,
    );
    // Still not "live": the account's entitlement is unverified, and only a
    // billable call can settle it.
    expect(readiness.status).toBe("paid_verification_required");
  });

  it("reports the production posture as off, without inventing coverage", () => {
    const readiness = aiVisibilityReadiness(readPhase0Config(baseEnv), true);
    expect(readiness.liveProviderEnabled).toBe(false);
    expect(readiness.paidCallsEnabled).toBe(false);
    expect(readiness.environment).toBe("production");
  });
});
