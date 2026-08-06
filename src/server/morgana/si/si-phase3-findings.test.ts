import { describe, expect, it } from "vitest";
import { buildEvents } from "./backlink-findings";
import { scoreBacklinkRisk } from "./backlink-risk";

/** Phase-3 event construction: which findings are raised, and exactly once. */

const BRAND = ["checksig"] as const;

describe("finding construction", () => {
  const risk = scoreBacklinkRisk({
    normalizedDomain: "checksig-support.tk",
    domainRoot: "checksig-support.tk",
    tld: "tk",
    brandTokens: BRAND,
    spamScore: 80,
  });

  it("raises a finding for a domain that was never 'new'", async () => {
    // The regression this guards: findings used to be derived from the diff
    // alone, so a domain present in the very first snapshot — which has no
    // diff to derive from — could never produce one. A domain already
    // impersonating us when monitoring started would have stayed invisible.
    const events = buildEvents({
      entityId: "se_1",
      day: "2026-08-06",
      added: [],
      removed: [],
      riskByDomain: new Map([["checksig-support.tk", risk]]),
      brandSignalsByDomain: new Map(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("possible_impersonation");
    expect(events[0]?.subjectDomain).toBe("checksig-support.tk");
  });

  it("does not also announce a flagged domain as a routine gain", async () => {
    const events = buildEvents({
      entityId: "se_1",
      day: "2026-08-06",
      added: [{ key: "k", domain: "checksig-support.tk" }],
      removed: [],
      riskByDomain: new Map([["checksig-support.tk", risk]]),
      brandSignalsByDomain: new Map(),
    });
    expect(events).toHaveLength(1);
    expect(
      events.some((event) => event.eventType === "referring_domain_gained"),
    ).toBe(false);
  });

  it("keys findings by domain and day, so one domain announces once", async () => {
    const events = buildEvents({
      entityId: "se_1",
      day: "2026-08-06",
      added: [],
      removed: [],
      riskByDomain: new Map([["checksig-support.tk", risk]]),
      brandSignalsByDomain: new Map(),
    });
    expect(events[0]?.dedupeKey).toBe(
      "finding|se_1|checksig-support.tk|2026-08-06",
    );
  });
});
