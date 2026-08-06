import { isEnabled, type Phase0Config } from "../phase0-env";
import { checkBudget } from "./budget";
import { globalSpend } from "./budget-authority";
import { fixtureKeywords, fixtureOverview, fixturePages } from "./fixtures";
import { runLiveDomainRefresh } from "./refresh-live";
import {
  computeDeltas,
  computeVisibilityShare,
  type DeltaSet,
  type VisibilityShareOutcome,
} from "./metrics";
import * as store from "./store";
import * as jobs from "./job-store";
import * as ledger from "./ledger-store";
import type { SnapshotKeywordRow, SnapshotPageRow } from "./store";
import { resolveProviderStatus } from "./provider-status";

export { resolveProviderStatus } from "./provider-status";

/**
 * Morgana Search Intelligence — orchestration.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Sits between the private API surface and the store. Every path that could
 * cost money passes through `checkBudget` first, and every provider call is
 * recorded in the ledger whether it succeeded, failed or was served from cache.
 *
 * NOTE ON SCHEDULING: this engine has no cron. Refresh is driven by Morgana's
 * existing scheduler over the Service Binding, which preserves the Phase-0
 * property that the engine cannot spend unless Morgana asks it to.
 */

const TOP_KEYWORD_LIMIT = 100;
const TOP_PAGE_LIMIT = 100;

export type ProviderStatus =
  | "not_configured"
  | "fixture"
  | "live"
  | "budget_exhausted"
  | "circuit_open";

export interface RefreshOutcome {
  entityId: string;
  jobId: string | null;
  status: "created" | "reused" | "skipped" | "failed";
  snapshotId: string | null;
  reason?: string;
  costMicros: number;
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Resolve the budget limits from the Phase-0 config. */
function limitsFrom(config: Phase0Config) {
  return {
    dailyCapMicros: config.SEO_DATAFORSEO_DAILY_COST_CAP_USD,
    monthlyCapMicros: config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD,
    paidCallsEnabled: isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED),
    circuitBreakerThreshold: 5,
  };
}

/**
 * Refresh one entity, producing at most one snapshot per entity/market/day.
 *
 * Returns rather than throws for every expected outcome (already refreshed,
 * budget exhausted, entity disabled), because the caller is a scheduler tick
 * that must keep going for the remaining entities.
 */
export async function refreshEntity(
  config: Phase0Config,
  env: object,
  input: {
    entityId: string;
    trigger: "scheduled" | "manual";
    requestedBy?: string | null;
    force?: boolean;
    now?: Date;
  },
): Promise<RefreshOutcome> {
  const now = input.now ?? new Date();
  const snapshotDate = store.snapshotDateFor(now);
  const month = monthOf(snapshotDate);

  const entity = await store.getEntity(input.entityId);
  if (!entity) {
    return {
      entityId: input.entityId,
      jobId: null,
      status: "skipped",
      snapshotId: null,
      reason: "entity_not_found",
      costMicros: 0,
    };
  }
  if (!entity.enabled) {
    return {
      entityId: entity.id,
      jobId: null,
      status: "skipped",
      snapshotId: null,
      reason: "entity_disabled",
      costMicros: 0,
    };
  }

  // Today's snapshot already exists — the cheapest possible outcome, and the
  // one that makes a duplicated tick free rather than billable.
  const dedupeKey = store.snapshotDedupeKey(
    entity.id,
    entity.locationCode,
    entity.languageCode,
    snapshotDate,
  );
  const existing = await store.latestSnapshot(entity.id);
  if (!input.force && existing?.dedupeKey === dedupeKey) {
    return {
      entityId: entity.id,
      jobId: null,
      status: "reused",
      snapshotId: existing.id,
      reason: "snapshot_already_current",
      costMicros: 0,
    };
  }

  const job = await jobs.claimJob({
    entityId: entity.id,
    snapshotDate,
    trigger: input.trigger,
    requestedBy: input.requestedBy ?? null,
    force: input.force ?? false,
  });
  if (!job) {
    return {
      entityId: entity.id,
      jobId: null,
      status: "skipped",
      snapshotId: null,
      reason: "job_already_claimed",
      costMicros: 0,
    };
  }

  const providerStatus = resolveProviderStatus(config, env);

  // A PRODUCTION ENGINE NEVER MANUFACTURES A FIXTURE.
  //
  // Morgana's client already refuses fixture payloads in production, but that
  // guard protects the READER: by the time it fires, a synthetic row has been
  // written to the production database, where it outlives the request and is
  // indistinguishable from a measurement to anything that reads D1 directly —
  // a SQL check, an export, a later phase. The write is the damage, so it is
  // refused at the writer too.
  //
  // Reached whenever the credential is missing or spend is off in a production
  // deployment. That is a configuration fault, so it fails loudly as a skipped
  // job rather than quietly producing plausible numbers.
  if (
    providerStatus === "fixture" &&
    config.SEARCH_INTELLIGENCE_ENVIRONMENT === "production"
  ) {
    await jobs.finishJob(job.id, {
      status: "skipped",
      skipReason: "fixture_refused_in_production",
    });
    return {
      entityId: entity.id,
      jobId: job.id,
      status: "skipped",
      snapshotId: null,
      reason: "fixture_refused_in_production",
      costMicros: 0,
    };
  }

  // Fixture mode: no provider call, no spend, and the snapshot is stamped
  // `source: "fixture"` so nothing downstream can mistake it for measurement.
  if (providerStatus === "fixture") {
    const metrics = fixtureOverview(entity.normalizedDomain, snapshotDate);
    const keywords = fixtureKeywords(
      entity.normalizedDomain,
      snapshotDate,
      TOP_KEYWORD_LIMIT,
    );
    const pages = fixturePages(
      entity.normalizedDomain,
      snapshotDate,
      TOP_PAGE_LIMIT,
    );
    const result = await store.persistSnapshot({
      entity,
      snapshotDate,
      metrics,
      keywords,
      pages,
      source: "fixture",
      estimatedCostMicros: 0,
      actualCostMicros: 0,
    });
    await ledger.recordUsage({
      day: snapshotDate,
      entityId: entity.id,
      jobId: job.id,
      endpointPath: "fixture/domain_overview",
      meteringClass: "cache",
    });
    await jobs.finishJob(job.id, {
      status: "succeeded",
      snapshotId: result.snapshotId,
    });
    return {
      entityId: entity.id,
      jobId: job.id,
      status: result.created ? "created" : "reused",
      snapshotId: result.snapshotId,
      reason: "fixture_source",
      costMicros: 0,
    };
  }

  // Any real collection needs both a credential and budget headroom.
  if (providerStatus === "not_configured") {
    await jobs.finishJob(job.id, {
      status: "skipped",
      skipReason: "credential_not_configured",
    });
    return {
      entityId: entity.id,
      jobId: job.id,
      status: "skipped",
      snapshotId: null,
      reason: "credential_not_configured",
      costMicros: 0,
    };
  }

  // SPEND COMES FROM THE LEDGER, not from `search_budget_state`.
  //
  // That table has a read path and no write path — a deliberate phase-1 gap,
  // because nothing could spend yet. Live collection closes that gap, and the
  // consequence of leaving it open would be a cap that never binds: the guard
  // would read `monthlyCostMicros: 0` forever, however much had been spent.
  //
  // Deriving the totals from the ledger rows that recorded the spend is the
  // fix with no dual write to drift. The state row is still consulted for the
  // circuit breaker, which is genuinely its own state and not derivable from
  // usage.
  const budgetState = await ledger.readBudgetState(month);
  // GLOBAL spend, not phase 1's own. Every collector weighing only its own
  // ledger against a shared cap is what let the day reach 0.21400 USD against
  // 0.20 — four correct local answers adding up to a wrong global one.
  const global = await globalSpend(config, { now });
  const decision = checkBudget(
    limitsFrom(config),
    {
      dailyCostMicros: global.dailyActualMicros + global.openReservationsMicros,
      monthlyCostMicros:
        global.monthlyActualMicros + global.openReservationsMicros,
      consecutiveFailures: budgetState.consecutiveFailures,
      circuitOpenedAt: budgetState.circuitOpenedAt,
    },
    now,
  );
  if (!decision.allowed) {
    await ledger.recordUsage({
      day: snapshotDate,
      entityId: entity.id,
      jobId: job.id,
      endpointPath: "dataforseo_labs/google/domain_rank_overview/live",
      meteringClass: "paid_submission",
      blockedByBudget: true,
    });
    await jobs.finishJob(job.id, {
      status: "skipped",
      skipReason: decision.reason ?? "budget_blocked",
    });
    return {
      entityId: entity.id,
      jobId: job.id,
      status: "skipped",
      snapshotId: null,
      reason: decision.reason ?? "budget_blocked",
      costMicros: 0,
    };
  }

  const live = await runLiveDomainRefresh({
    entity,
    jobId: job.id,
    snapshotDate,
    keywordLimit: TOP_KEYWORD_LIMIT,
    pageLimit: TOP_PAGE_LIMIT,
    force: input.force ?? false,
  });
  return {
    entityId: entity.id,
    jobId: job.id,
    status: live.status,
    snapshotId: live.snapshotId,
    reason: live.reason,
    costMicros: live.costMicros,
  };
}

/** Entities whose scheduled refresh is due. */
export function selectDueEntities(
  entities: readonly store.SearchEntityRow[],
  now: Date = new Date(),
): store.SearchEntityRow[] {
  return entities.filter((entity) => {
    if (!entity.enabled) return false;
    if (!entity.lastRefreshedAt) return true;
    const last = new Date(entity.lastRefreshedAt).getTime();
    if (Number.isNaN(last)) return true;
    return now.getTime() - last >= entity.refreshIntervalHours * 3_600_000;
  });
}

export interface DomainOverview {
  entity: store.SearchEntityRow;
  snapshot: {
    id: string;
    snapshotDate: string;
    fetchedAt: string;
    source: string;
    organicTrafficEstimate: number | null;
    organicKeywordCount: number | null;
    backlinkCount: number | null;
    referringDomainCount: number | null;
    rankSignal: number | null;
  } | null;
  deltas: DeltaSet | null;
  // Drizzle's inferred row types rather than `unknown[]`: the store already
  // knows the shape, which lets callers read `topKeywords[0]?.keyword` without
  // asserting anything.
  topKeywords: SnapshotKeywordRow[];
  topPages: SnapshotPageRow[];
  freshness: "fresh" | "stale" | "none";
}

const STALE_AFTER_HOURS = 48;

export async function domainOverview(
  entityId: string,
  options: { keywordLimit?: number; pageLimit?: number; now?: Date } = {},
): Promise<DomainOverview | null> {
  const entity = await store.getEntity(entityId);
  if (!entity) return null;
  const snapshot = await store.latestSnapshot(entityId);
  if (!snapshot) {
    return {
      entity,
      snapshot: null,
      deltas: null,
      topKeywords: [],
      topPages: [],
      freshness: "none",
    };
  }
  const history = await store.snapshotHistory(
    entityId,
    isoDaysAgo(options.now ?? new Date(), 90),
  );
  const deltas = computeDeltas(
    {
      snapshotDate: snapshot.snapshotDate,
      organicTrafficEstimate: snapshot.organicTrafficEstimate,
      organicKeywordCount: snapshot.organicKeywordCount,
      backlinkCount: snapshot.backlinkCount,
      referringDomainCount: snapshot.referringDomainCount,
    },
    history,
  );
  const [topKeywords, topPages] = await Promise.all([
    store.snapshotKeywords(snapshot.id, options.keywordLimit ?? 20),
    store.snapshotPages(snapshot.id, options.pageLimit ?? 20),
  ]);
  const ageMs =
    (options.now ?? new Date()).getTime() -
    new Date(snapshot.fetchedAt).getTime();
  return {
    entity,
    snapshot: {
      id: snapshot.id,
      snapshotDate: snapshot.snapshotDate,
      fetchedAt: snapshot.fetchedAt,
      source: snapshot.source,
      organicTrafficEstimate: snapshot.organicTrafficEstimate,
      organicKeywordCount: snapshot.organicKeywordCount,
      backlinkCount: snapshot.backlinkCount,
      referringDomainCount: snapshot.referringDomainCount,
      rankSignal: snapshot.rankSignal,
    },
    deltas,
    topKeywords,
    topPages,
    freshness: ageMs > STALE_AFTER_HOURS * 3_600_000 ? "stale" : "fresh",
  };
}

interface ComparisonRow {
  entity: store.SearchEntityRow;
  snapshotDate: string | null;
  organicTrafficEstimate: number | null;
  organicKeywordCount: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  deltas: DeltaSet | null;
  visibilityShare: number | null;
  visibilityShareStatus: string;
  topKeyword: string | null;
  topPage: string | null;
  freshness: "fresh" | "stale" | "none";
}

interface ComparisonResult {
  rows: ComparisonRow[];
  visibility: VisibilityShareOutcome;
}

export async function compareDomains(
  entityIds: readonly string[],
  options: { now?: Date } = {},
): Promise<ComparisonResult> {
  const now = options.now ?? new Date();
  const overviews = await Promise.all(
    entityIds.map((id) =>
      domainOverview(id, { keywordLimit: 1, pageLimit: 1, now }),
    ),
  );
  const present = overviews.filter((o): o is DomainOverview => o !== null);

  const visibility = computeVisibilityShare(
    present.map((o) => ({
      entityId: o.entity.id,
      organicTrafficEstimate: o.snapshot?.organicTrafficEstimate ?? null,
      locationCode: o.entity.locationCode,
      languageCode: o.entity.languageCode,
      // An entity with no snapshot cannot be dated; use the epoch so the
      // contemporaneity check fails loudly rather than silently passing.
      snapshotDate: o.snapshot?.snapshotDate ?? "1970-01-01",
    })),
  );
  const shareById = new Map(
    visibility.results.map((r) => [r.entityId, r] as const),
  );

  return {
    rows: present.map((o) => {
      const share = shareById.get(o.entity.id);
      return {
        entity: o.entity,
        snapshotDate: o.snapshot?.snapshotDate ?? null,
        organicTrafficEstimate: o.snapshot?.organicTrafficEstimate ?? null,
        organicKeywordCount: o.snapshot?.organicKeywordCount ?? null,
        backlinkCount: o.snapshot?.backlinkCount ?? null,
        referringDomainCount: o.snapshot?.referringDomainCount ?? null,
        deltas: o.deltas,
        visibilityShare: share?.share ?? null,
        visibilityShareStatus: share?.status ?? "insufficient_data",
        topKeyword: o.topKeywords[0]?.keyword ?? null,
        topPage: o.topPages[0]?.url ?? null,
        freshness: o.freshness,
      };
    }),
    visibility,
  };
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}
