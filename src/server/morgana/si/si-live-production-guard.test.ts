import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Morgana Search Intelligence — a production engine never writes a fixture.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * Morgana's client already refuses fixture PAYLOADS in production. That guard
 * protects the reader and fires too late: by then the synthetic row is in the
 * production database, where nothing that reads D1 directly — a SQL check, an
 * export, a later phase — can tell it from a measurement. These cases pin the
 * refusal at the writer, which is the only place that prevents the row.
 */

const persistSnapshot = vi.fn();
const recordUsage = vi.fn();
const ledgerTotals = vi.fn();
const readBudgetState = vi.fn();
const claimJob = vi.fn();
const finishJob = vi.fn();
const runLiveDomainRefresh = vi.fn();
const getEntity = vi.fn();
const latestSnapshot = vi.fn();

// The whole `store` surface `service.ts` reaches for: it imports `@/db` and
// cannot be loaded outside the Workers runtime, so it is replaced wholesale.
vi.mock("./store", () => ({
  persistSnapshot,
  getEntity,
  latestSnapshot,
  snapshotDateFor: () => "2026-08-06",
  snapshotDedupeKey: () => "se_1|2380|it|2026-08-06",
  snapshotHistory: vi.fn(),
  snapshotKeywords: vi.fn(),
  snapshotPages: vi.fn(),
}));
vi.mock("./job-store", () => ({ claimJob, finishJob }));
vi.mock("./ledger-store", () => ({
  recordUsage,
  ledgerTotals,
  readBudgetState,
}));
vi.mock("./refresh-live", () => ({ runLiveDomainRefresh }));

const { readPhase0Config } = await import("../phase0-env");
const { refreshEntity } = await import("./service");

const ENTITY = {
  id: "se_1",
  displayName: "CheckSig",
  canonicalDomain: "checksig.com",
  normalizedDomain: "checksig.com",
  entityType: "primary",
  enabled: true,
  priority: "high",
  includeSubdomains: false,
  locationCode: 2380,
  languageCode: "it",
  refreshIntervalHours: 24,
  backlinkIntervalHours: 168,
  lastRefreshedAt: null,
  lastBacklinkRefreshedAt: null,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
  disabledAt: null,
};

/**
 * A credential with spend OFF — the combination that resolves to `fixture`.
 * The environment is the only thing that varies between the cases below.
 */
const envFor = (environment: "staging" | "production") => ({
  SEARCH_INTELLIGENCE_ENABLED: "true",
  SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED: "false",
  SEARCH_INTELLIGENCE_ENVIRONMENT: environment,
  DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY: "present-but-unusable",
});

beforeEach(() => {
  vi.clearAllMocks();
  getEntity.mockResolvedValue(ENTITY);
  latestSnapshot.mockResolvedValue(null);
  claimJob.mockResolvedValue({ id: "rj_1" });
  finishJob.mockResolvedValue(undefined);
  persistSnapshot.mockResolvedValue({ snapshotId: "ds_1", created: true });
  recordUsage.mockResolvedValue(undefined);
});

const run = async (environment: "staging" | "production") => {
  const env = envFor(environment);
  return refreshEntity(readPhase0Config(env), env, {
    entityId: ENTITY.id,
    trigger: "manual",
  });
};

describe("fixture refusal in production", () => {
  it("refuses to write a fixture snapshot when the engine is production", async () => {
    const result = await run("production");
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("fixture_refused_in_production");
    expect(result.snapshotId).toBeNull();
    // The point of the guard: nothing was written.
    expect(persistSnapshot).not.toHaveBeenCalled();
  });

  it("records the refusal on the job so it is visible after the request", async () => {
    await run("production");
    expect(finishJob).toHaveBeenCalledWith("rj_1", {
      status: "skipped",
      skipReason: "fixture_refused_in_production",
    });
  });

  it("spends nothing and calls no provider while refusing", async () => {
    const result = await run("production");
    expect(result.costMicros).toBe(0);
    expect(runLiveDomainRefresh).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("still serves fixtures in staging, which is what they are for", async () => {
    const result = await run("staging");
    expect(result.reason).toBe("fixture_source");
    expect(persistSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ source: "fixture" }),
    );
  });
});
