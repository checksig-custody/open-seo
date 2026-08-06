import { describe, expect, it } from "vitest";
import { resolveProviderStatus } from "./provider-status";

/**
 * Morgana Search Intelligence — which provider a collection will use.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * These two conditions were inverted and nothing covered them, which is why the
 * defect survived until the first refresh after the real credential was
 * provisioned: while no credential existed anywhere, both arms returned a
 * non-live status and the caller skipped either way, so the inversion had no
 * observable effect. The mapping cases live in `si-live-domain-collect.test.ts`.
 */

const config = (paidCalls: "true" | "false") => ({
  SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: paidCalls,
});

describe("provider status", () => {
  const withKey = { DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY: "x" };

  it("is not_configured without a credential, whatever the spend flag says", () => {
    expect(resolveProviderStatus(config("false"), {})).toBe("not_configured");
    expect(resolveProviderStatus(config("true"), {})).toBe("not_configured");
  });

  it("treats an empty credential as absent", () => {
    expect(
      resolveProviderStatus(config("true"), {
        DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY: "   ",
      }),
    ).toBe("not_configured");
  });

  it("is fixture when a credential exists but spending is off", () => {
    expect(resolveProviderStatus(config("false"), withKey)).toBe("fixture");
  });

  it("is live only with a credential and spending on", () => {
    expect(resolveProviderStatus(config("true"), withKey)).toBe("live");
  });
});
