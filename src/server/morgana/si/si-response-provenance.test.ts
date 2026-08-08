import { describe, expect, it } from "vitest";
import { envelope } from "./http";

const config = {
  ENGINE_UPSTREAM_RELEASE: "test",
  ENGINE_UPSTREAM_COMMIT: "test",
  SEARCH_INTELLIGENCE_ENVIRONMENT: "production",
} as never;

describe("Search Intelligence response provenance", () => {
  it("reports stored provider data as read-only when collection is paused", () => {
    const result = envelope(
      config,
      {
        snapshot: { source: "dataforseo" },
        ai_visibility: { state: "not_live", observations: [] },
      },
      { providerStatus: "fixture" },
    );

    expect(result.provider_status).toBe("read_only");
  });

  it("keeps incomplete or absent optional data distinct from fixtures", () => {
    const result = envelope(
      config,
      {
        share_of_search: {
          status: "insufficient_data",
          covered: 2,
          eligible: 6,
        },
        ai_visibility: null,
      },
      { providerStatus: "fixture" },
    );

    expect(result.provider_status).toBe("read_only");
  });

  it("preserves a real fixture provenance for Morgana to reject in production", () => {
    const result = envelope(
      config,
      { snapshot: { source: "fixture" } },
      { providerStatus: "fixture" },
    );

    expect(result.provider_status).toBe("fixture");
  });
});
