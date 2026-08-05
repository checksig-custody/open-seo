import { describe, expect, it } from "vitest";
import {
  DomainValidationError,
  normalizeEntityDomain,
  normalizePageUrl,
} from "./domains";
import {
  computeDelta,
  computeDeltas,
  computeVisibilityShare,
  findBaseline,
  type SnapshotPoint,
} from "./metrics";
import {
  checkBudget,
  crossedThreshold,
  detectUnexpectedSpend,
  isMetered,
  isProviderCall,
  levelFor,
  projectMonthEndMicros,
  usdToMicros,
} from "./budget";

/**
 * Morgana Search Intelligence — phase 1 core tests.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 */

describe("entity domain validation", () => {
  it("normalises a bare domain", () => {
    const result = normalizeEntityDomain("CheckSig.com");
    expect(result.normalized).toBe("checksig.com");
    expect(result.display).toBe("CheckSig.com");
    expect(result.isInternationalized).toBe(false);
  });

  it("strips protocol and www", () => {
    expect(normalizeEntityDomain("https://www.conio.com").normalized).toBe(
      "conio.com",
    );
  });

  it("reduces to the registrable domain unless subdomains are requested", () => {
    expect(normalizeEntityDomain("blog.bitpanda.com").normalized).toBe(
      "bitpanda.com",
    );
    expect(
      normalizeEntityDomain("blog.bitpanda.com", { includeSubdomains: true })
        .normalized,
    ).toBe("blog.bitpanda.com");
  });

  it("accepts a trailing dot and mixed case", () => {
    expect(normalizeEntityDomain("  BINANCE.COM.  ").normalized).toBe(
      "binance.com",
    );
  });

  // §35 — each of these is a rejection, not a silent normalisation.
  it("rejects credentials embedded in the URL", () => {
    expect(() => normalizeEntityDomain("https://user:pass@evil.com")).toThrow(
      DomainValidationError,
    );
    expect(() => normalizeEntityDomain("user@evil.com")).toThrow(
      /credentials/i,
    );
  });

  it("rejects non-HTTP schemes", () => {
    expect(() => normalizeEntityDomain("file://etc/passwd")).toThrow(/http/i);
    expect(() => normalizeEntityDomain("ftp://example.com")).toThrow(/http/i);
  });

  it("rejects a bare domain carrying a path", () => {
    expect(() => normalizeEntityDomain("example.com/admin")).toThrow(/path/i);
  });

  it("rejects IP literals", () => {
    expect(() => normalizeEntityDomain("127.0.0.1")).toThrow();
    expect(() => normalizeEntityDomain("http://169.254.169.254")).toThrow();
    expect(() => normalizeEntityDomain("10.0.0.1")).toThrow();
    expect(() => normalizeEntityDomain("[::1]")).toThrow();
  });

  it("rejects loopback and private suffixes", () => {
    expect(() => normalizeEntityDomain("localhost")).toThrow();
    expect(() => normalizeEntityDomain("service.internal")).toThrow();
    expect(() => normalizeEntityDomain("printer.local")).toThrow();
  });

  it("rejects malformed and empty input", () => {
    expect(() => normalizeEntityDomain("")).toThrow(/required/i);
    expect(() => normalizeEntityDomain("   ")).toThrow(/required/i);
    expect(() => normalizeEntityDomain("not a domain")).toThrow();
    expect(() => normalizeEntityDomain("example.invalidtld")).toThrow();
  });

  it("rejects an over-long input before parsing", () => {
    expect(() => normalizeEntityDomain(`${"a".repeat(300)}.com`)).toThrow(
      /too long/i,
    );
  });

  it("flags an internationalised domain and keeps the stored form ASCII", () => {
    // Showing punycode rather than Unicode is the homograph mitigation.
    const result = normalizeEntityDomain("münchen.de");
    expect(result.normalized).toBe("xn--mnchen-3ya.de");
    expect(result.isInternationalized).toBe(true);
  });

  it("treats an already-punycode domain as internationalised", () => {
    expect(normalizeEntityDomain("xn--mnchen-3ya.de").isInternationalized).toBe(
      true,
    );
  });

  it("normalises two spellings of the same domain to one key", () => {
    const a = normalizeEntityDomain("https://WWW.Coinbase.com/");
    const b = normalizeEntityDomain("coinbase.com");
    expect(a.normalized).toBe(b.normalized);
  });
});

describe("page url normalisation", () => {
  it("strips protocol, www, fragment and trailing slash", () => {
    expect(normalizePageUrl("https://www.checksig.com/blog/post/#top")).toBe(
      "checksig.com/blog/post",
    );
  });

  it("removes tracking parameters but keeps meaningful ones", () => {
    expect(
      normalizePageUrl("https://checksig.com/p?utm_source=x&id=7&gclid=y"),
    ).toBe("checksig.com/p?id=7");
  });

  it("keeps the root path", () => {
    expect(normalizePageUrl("https://checksig.com/")).toBe("checksig.com");
  });

  it("returns unparseable input lowercased rather than dropping the row", () => {
    expect(normalizePageUrl("::::")).toBe("::::");
  });
});

describe("deltas", () => {
  it("computes absolute and relative change", () => {
    expect(computeDelta(120, 100)).toEqual({
      status: "ok",
      absolute: 20,
      relative: 0.2,
    });
  });

  it("reports insufficient_history when the baseline is missing", () => {
    expect(computeDelta(120, null).status).toBe("insufficient_history");
  });

  // The distinction that keeps the UI honest.
  it("reports not_available when the current value is missing", () => {
    expect(computeDelta(null, 100).status).toBe("not_available");
  });

  it("never reports zero as a substitute for missing history", () => {
    const delta = computeDelta(120, undefined);
    expect(delta.absolute).toBeNull();
    expect(delta.relative).toBeNull();
  });

  it("omits the percentage when the baseline is zero rather than emitting Infinity", () => {
    const delta = computeDelta(5, 0);
    expect(delta.status).toBe("ok");
    expect(delta.absolute).toBe(5);
    expect(delta.relative).toBeNull();
  });

  it("finds the nearest baseline inside the tolerance window", () => {
    const history: SnapshotPoint[] = [
      point("2026-07-30", 100),
      point("2026-08-01", 110),
    ];
    expect(findBaseline(history, "2026-08-08", 7)?.snapshotDate).toBe(
      "2026-08-01",
    );
  });

  it("returns no baseline when nothing falls inside the window", () => {
    const history: SnapshotPoint[] = [point("2026-01-01", 100)];
    expect(findBaseline(history, "2026-08-08", 7)).toBeNull();
  });

  it("excludes the current snapshot from its own baseline", () => {
    const current = point("2026-08-08", 200);
    const deltas = computeDeltas(current, [current]);
    expect(deltas.trafficDelta1d.status).toBe("insufficient_history");
  });

  it("computes a full delta set from a sparse weekly history", () => {
    const current = point("2026-08-08", 200, 50);
    const history = [
      point("2026-08-07", 190, 48),
      point("2026-08-01", 150, 40),
      point("2026-07-10", 100, 30),
    ];
    const deltas = computeDeltas(current, history);
    expect(deltas.trafficDelta1d.absolute).toBe(10);
    expect(deltas.trafficDelta7d.absolute).toBe(50);
    expect(deltas.trafficDelta30d.absolute).toBe(100);
    expect(deltas.keywordCountDelta7d.absolute).toBe(10);
  });
});

describe("estimated organic visibility share", () => {
  const base = {
    locationCode: 2380,
    languageCode: "it",
    snapshotDate: "2026-08-08",
  };

  it("computes shares that sum to one", () => {
    const outcome = computeVisibilityShare([
      { entityId: "a", organicTrafficEstimate: 300, ...base },
      { entityId: "b", organicTrafficEstimate: 100, ...base },
    ]);
    expect(outcome.status).toBe("ok");
    expect(outcome.results[0]?.share).toBeCloseTo(0.75, 6);
    expect(outcome.results[1]?.share).toBeCloseTo(0.25, 6);
    const sum = outcome.results.reduce((acc, r) => acc + (r.share ?? 0), 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("refuses with fewer than two domains", () => {
    const outcome = computeVisibilityShare([
      { entityId: "a", organicTrafficEstimate: 300, ...base },
    ]);
    expect(outcome.status).toBe("insufficient_data");
  });

  // A missing domain would silently inflate everyone else's share.
  it("refuses when any compared domain has no traffic estimate", () => {
    const outcome = computeVisibilityShare([
      { entityId: "a", organicTrafficEstimate: 300, ...base },
      { entityId: "b", organicTrafficEstimate: null, ...base },
    ]);
    expect(outcome.status).toBe("insufficient_data");
    expect(outcome.reason).toMatch(/no traffic estimate/);
    expect(outcome.results.every((r) => r.share === null)).toBe(true);
  });

  it("refuses on a zero total instead of dividing by zero", () => {
    const outcome = computeVisibilityShare([
      { entityId: "a", organicTrafficEstimate: 0, ...base },
      { entityId: "b", organicTrafficEstimate: 0, ...base },
    ]);
    expect(outcome.status).toBe("insufficient_data");
    expect(outcome.results.every((r) => r.share === null)).toBe(true);
  });

  it("refuses to mix incompatible markets", () => {
    const outcome = computeVisibilityShare([
      { entityId: "a", organicTrafficEstimate: 300, ...base },
      {
        entityId: "b",
        organicTrafficEstimate: 100,
        locationCode: 2840,
        languageCode: "en",
        snapshotDate: "2026-08-08",
      },
    ]);
    expect(outcome.status).toBe("insufficient_data");
    expect(outcome.reason).toMatch(/market/i);
  });

  it("refuses non-contemporaneous snapshots", () => {
    const outcome = computeVisibilityShare([
      { entityId: "a", organicTrafficEstimate: 300, ...base },
      {
        entityId: "b",
        organicTrafficEstimate: 100,
        locationCode: 2380,
        languageCode: "it",
        snapshotDate: "2026-06-01",
      },
    ]);
    expect(outcome.status).toBe("insufficient_data");
    expect(outcome.reason).toMatch(/contemporaneous/);
  });

  it("tolerates a small spread between snapshots", () => {
    const outcome = computeVisibilityShare([
      { entityId: "a", organicTrafficEstimate: 300, ...base },
      {
        entityId: "b",
        organicTrafficEstimate: 100,
        locationCode: 2380,
        languageCode: "it",
        snapshotDate: "2026-08-06",
      },
    ]);
    expect(outcome.status).toBe("ok");
  });
});

describe("budget guard", () => {
  const limits = {
    dailyCapMicros: 250_000,
    monthlyCapMicros: 5_000_000,
    paidCallsEnabled: true,
    circuitBreakerThreshold: 5,
  };
  const usage = {
    dailyCostMicros: 0,
    monthlyCostMicros: 0,
    consecutiveFailures: 0,
    circuitOpenedAt: null,
  };

  it("allows a call inside both caps", () => {
    expect(checkBudget(limits, usage).allowed).toBe(true);
  });

  it("blocks when paid calls are disabled", () => {
    const decision = checkBudget({ ...limits, paidCallsEnabled: false }, usage);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("paid_calls_disabled");
  });

  // Zero means "cannot spend", never "unlimited".
  it("blocks on a zero cap even when the flag is on", () => {
    expect(checkBudget({ ...limits, monthlyCapMicros: 0 }, usage).reason).toBe(
      "zero_cost_cap",
    );
    expect(checkBudget({ ...limits, dailyCapMicros: 0 }, usage).reason).toBe(
      "zero_cost_cap",
    );
  });

  it("blocks at the daily cap", () => {
    expect(
      checkBudget(limits, { ...usage, dailyCostMicros: 250_000 }).reason,
    ).toBe("daily_cap_reached");
  });

  it("blocks at the monthly cap and reports exhausted", () => {
    const decision = checkBudget(limits, {
      ...usage,
      monthlyCostMicros: 5_000_000,
    });
    expect(decision.reason).toBe("monthly_cap_reached");
    expect(decision.level).toBe("exhausted");
  });

  it("stops new billable submissions at 95%", () => {
    const decision = checkBudget(limits, {
      ...usage,
      monthlyCostMicros: 4_800_000,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.level).toBe("stopping");
  });

  it("still allows calls at the warning and degraded thresholds", () => {
    expect(
      checkBudget(limits, { ...usage, monthlyCostMicros: 3_600_000 }).allowed,
    ).toBe(true);
    expect(
      checkBudget(limits, { ...usage, monthlyCostMicros: 4_300_000 }).allowed,
    ).toBe(true);
  });

  it("maps percentages to the documented ladder", () => {
    expect(levelFor(10)).toBe("ok");
    expect(levelFor(70)).toBe("warning");
    expect(levelFor(85)).toBe("degraded");
    expect(levelFor(95)).toBe("stopping");
    expect(levelFor(100)).toBe("exhausted");
  });

  it("blocks while the circuit breaker is open and recovers after cooldown", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const justOpened = {
      ...usage,
      circuitOpenedAt: "2026-08-08T11:55:00Z",
    };
    expect(checkBudget(limits, justOpened, now).reason).toBe("circuit_open");
    const longAgo = { ...usage, circuitOpenedAt: "2026-08-08T11:00:00Z" };
    expect(checkBudget(limits, longAgo, now).allowed).toBe(true);
  });
});

describe("metering classes", () => {
  it("counts only billable and quota-rationed calls as metered", () => {
    expect(isMetered("paid_submission")).toBe(true);
    expect(isMetered("quota_metered_free")).toBe(true);
    // The decision-#84 lesson: free lifecycle calls must not ration paid work.
    expect(isMetered("free_poll")).toBe(false);
    expect(isMetered("result_fetch")).toBe(false);
    expect(isMetered("cache")).toBe(false);
  });

  it("treats only cache as a non-call", () => {
    expect(isProviderCall("cache")).toBe(false);
    expect(isProviderCall("free_poll")).toBe(true);
  });
});

describe("cost arithmetic", () => {
  it("converts USD to integer micro-USD without drift", () => {
    expect(usdToMicros(0.0006)).toBe(600);
    expect(usdToMicros(0.02)).toBe(20_000);
    expect(Number.isInteger(usdToMicros(0.1 + 0.2))).toBe(true);
  });

  it("projects month-end spend from the elapsed portion", () => {
    // $0.50 by the 10th of a 31-day month.
    expect(
      projectMonthEndMicros(500_000, new Date("2026-08-10T00:00:00Z")),
    ).toBe(1_550_000);
  });

  it("projects zero when nothing has been spent", () => {
    expect(projectMonthEndMicros(0)).toBe(0);
  });
});

describe("unexpected spend detection", () => {
  it("flags metered requests while paid calls are off", () => {
    expect(detectUnexpectedSpend(false, 1, 0)).toBe(true);
    expect(detectUnexpectedSpend(false, 0, 500)).toBe(true);
    expect(detectUnexpectedSpend(false, 0, 0)).toBe(false);
    expect(detectUnexpectedSpend(true, 5, 1000)).toBe(false);
  });
});

describe("alert thresholds", () => {
  it("announces a threshold once and only on escalation", () => {
    expect(crossedThreshold(50, null)).toBeNull();
    expect(crossedThreshold(72, null)).toBe(70);
    expect(crossedThreshold(72, 70)).toBeNull();
    expect(crossedThreshold(88, 70)).toBe(85);
    expect(crossedThreshold(101, 95)).toBe(100);
  });

  it("emits at most one threshold per evaluation", () => {
    // Jumping from nothing to 100% announces 100, not 70+85+95+100.
    expect(crossedThreshold(100, null)).toBe(100);
  });
});

function point(
  snapshotDate: string,
  traffic: number | null,
  keywords: number | null = null,
): SnapshotPoint {
  return {
    snapshotDate,
    organicTrafficEstimate: traffic,
    organicKeywordCount: keywords,
    backlinkCount: null,
    referringDomainCount: null,
  };
}
