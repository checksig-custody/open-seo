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
const listEntities = vi.fn();
const dueKeywords = vi.fn();
const saveEvents = vi.fn();

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
  listEntities,
}));
vi.mock("./job-store", () => ({ claimJob, finishJob }));
vi.mock("./ledger-store", () => ({
  recordUsage,
  ledgerTotals,
  readBudgetState,
}));
vi.mock("./refresh-live", () => ({ runLiveDomainRefresh }));
vi.mock("./p2-store", () => ({
  dueKeywords,
  listTrackedKeywords: vi.fn(),
  listClusters: vi.fn(),
  getTrackedKeyword: vi.fn(),
  markChecked: vi.fn(),
  recordRank: vi.fn(),
  recentSnapshotDates: vi.fn(),
  observationsFor: vi.fn(),
}));
vi.mock("./p2-jobs-store", () => ({
  claimJob: vi.fn(),
  finishJob: vi.fn(),
  recordPhase2Usage: vi.fn(),
}));
vi.mock("./rank-live-service", () => ({
  submitDueRankTask: vi.fn(),
  collectReadyRankTasks: vi.fn(),
}));
vi.mock("./p2-analytics-store", () => ({
  saveGapSnapshot: vi.fn(),
  saveEvents,
  saveShareSnapshot: vi.fn(),
  shareHistory: vi.fn(),
}));
vi.mock("./p2-derived", () => ({ recomputeDerivedState: vi.fn() }));

const { readPhase0Config } = await import("../phase0-env");
const { refreshEntity } = await import("./service");
const { runRankTick } = await import("./p2-service");
const { collectReadyRankTasks, submitDueRankTask } =
  await import("./rank-live-service");
const { recordRank } = await import("./p2-store");

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
  // Set here, not at mock-definition time: `clearAllMocks` wipes implementations.
  listEntities.mockResolvedValue([ENTITY]);
  dueKeywords.mockResolvedValue([]);
  saveEvents.mockResolvedValue([]);
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

/**
 * The same rule, for rank tracking.
 *
 * `refreshEntity` refused a fixture in production from phase 1; `runRankTick`
 * did not, and a production tick with spend switched off wrote five synthetic
 * POSITIONS into the production database. A fixture rank is worse than a
 * fixture metric — it is a number a human acts on — and nothing reading D1
 * afterwards can tell it from a measurement.
 */
describe("fixture refusal in the rank tick", () => {
  beforeEach(() => {
    // Collection now runs whenever a credential exists — see the gating tests
    // below — so it must have a result to return in every rank-tick case.
    vi.mocked(collectReadyRankTasks).mockResolvedValue({
      collected: 0,
      pending: 0,
      failed: 0,
      observations: 0,
      keywordsTouched: [],
    });
  });

  it("refuses to manufacture rankings when the engine is production", async () => {
    const env = envFor("production");
    const result = await runRankTick(readPhase0Config(env), env);
    expect(result.skipped).toBe("fixture_refused_in_production");
    expect(result.observationsRecorded).toBe(0);
    // Nothing synthetic was written. Collection may run — it cannot invent a
    // ranking — but no fixture rank reaches the database.
    expect(recordRank).not.toHaveBeenCalled();
  });

  it("still serves fixture rankings in staging", async () => {
    const env = envFor("staging");
    const result = await runRankTick(readPhase0Config(env), env);
    expect(result.skipped).not.toBe("fixture_refused_in_production");
  });
});

/**
 * SPENDING AND COLLECTING ARE DIFFERENT AUTHORITIES.
 *
 * `task_post` buys a SERP and needs spend authority. `task_get` reads one the
 * ledger already shows as bought and needs a credential and a receipt. Gating
 * both on `resolveProviderStatus` stranded paid work behind a switch it does
 * not use: with paid calls off the provider resolves to `fixture`, and the
 * guard above then refused the free fetch too. In production that meant spend
 * authority had to be switched on to retrieve something that costs nothing.
 */
const collectResult = (over: Record<string, unknown> = {}) => ({
  collected: 0,
  pending: 0,
  failed: 0,
  observations: 0,
  keywordsTouched: [] as string[],
  ...over,
});

describe("result fetch is gated on a receipt, not on spend authority", () => {
  it("collects a persisted live task in production with paid calls OFF", async () => {
    vi.mocked(collectReadyRankTasks).mockResolvedValue(
      collectResult({ collected: 1 }),
    );
    const env = envFor("production");
    const result = await runRankTick(readPhase0Config(env), env, {
      limit: 0,
      collectLimit: 1,
    });

    expect(collectReadyRankTasks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
    expect(result.collected).toBe(1);
    // Not "skipped": the tick did real work, and Morgana's scheduler returns
    // early on a skip, which would strand the observation it just collected.
    expect(result.skipped).toBeUndefined();
  });

  it("buys nothing while collecting: no keyword is even selected", async () => {
    vi.mocked(collectReadyRankTasks).mockResolvedValue(
      collectResult({ pending: 1 }),
    );
    const env = envFor("production");
    const result = await runRankTick(readPhase0Config(env), env, {
      limit: 0,
      collectLimit: 1,
    });

    expect(dueKeywords).not.toHaveBeenCalled();
    expect(submitDueRankTask).not.toHaveBeenCalled();
    expect(result.submitted).toBe(0);
    expect(result.pending).toBe(1);
  });

  it("refuses a submission with paid calls off even when one is asked for", async () => {
    vi.mocked(collectReadyRankTasks).mockResolvedValue(collectResult());
    const env = envFor("production");
    const result = await runRankTick(readPhase0Config(env), env, { limit: 5 });

    // Paid calls off in production resolves to `fixture`, which may not submit
    // and may not manufacture a ranking either.
    expect(submitDueRankTask).not.toHaveBeenCalled();
    expect(recordRank).not.toHaveBeenCalled();
    expect(result.skipped).toBe("fixture_refused_in_production");
  });

  it("says so plainly when a collect-only tick had nothing to collect", async () => {
    vi.mocked(collectReadyRankTasks).mockResolvedValue(collectResult());
    const env = envFor("production");
    const result = await runRankTick(readPhase0Config(env), env, {
      limit: 0,
      collectLimit: 1,
    });
    expect(result.skipped).toBe("collect_only_nothing_due");
  });

  it("still refuses everything without a credential — nothing to ask with", async () => {
    const env = { ...envFor("production") };
    delete (env as Record<string, unknown>)
      .DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY;
    const result = await runRankTick(readPhase0Config(env), env, {
      limit: 0,
      collectLimit: 1,
    });
    expect(result.skipped).toBe("credential_not_configured");
    expect(collectReadyRankTasks).not.toHaveBeenCalled();
  });
});
