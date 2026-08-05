import { isEnabled, type Phase0Config } from "../phase0-env";
import {
  checkBudget,
  crossedThreshold,
  detectUnexpectedSpend,
  levelFor,
  microsToUsd,
  projectMonthEndMicros,
  type BudgetLevel,
} from "./budget";
import { fixtureKeywords, fixtureOverview, fixturePages } from "./fixtures";
import {
  computeDeltas,
  computeVisibilityShare,
  type DeltaSet,
  type VisibilityShareOutcome,
} from "./metrics";
import * as store from "./store";

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

function credentialPresent(env: object): boolean {
  const value =
    (env as Record<string, unknown>).DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY ??
    (env as Record<string, unknown>).DATAFORSEO_API_KEY;
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Which data source a refresh would use right now.
 *
 * `fixture` is only ever chosen when paid calls are OFF. The engine must never
 * silently serve synthetic numbers in a configuration where an operator has
 * asked for real ones — a fixture mistaken for a measurement is worse than an
 * outage.
 */
export function resolveProviderStatus(
  config: Phase0Config,
  env: object,
): ProviderStatus {
  const paidCalls = isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED);
  if (!paidCalls) return credentialPresent(env) ? "not_configured" : "fixture";
  return credentialPresent(env) ? "live" : "not_configured";
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

  const job = await store.claimJob({
    entityId: entity.id,
    snapshotDate,
    trigger: input.trigger,
    requestedBy: input.requestedBy ?? null,
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
    await store.recordUsage({
      day: snapshotDate,
      entityId: entity.id,
      endpointPath: "fixture/domain_overview",
      meteringClass: "cache",
    });
    await store.finishJob(job.id, {
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
    await store.finishJob(job.id, {
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

  const budgetState = await store.readBudgetState(month);
  const decision = checkBudget(
    limitsFrom(config),
    {
      dailyCostMicros:
        budgetState.currentDay === snapshotDate
          ? budgetState.dailyCostMicros
          : 0,
      monthlyCostMicros: budgetState.monthlyCostMicros,
      consecutiveFailures: budgetState.consecutiveFailures,
      circuitOpenedAt: budgetState.circuitOpenedAt,
    },
    now,
  );
  if (!decision.allowed) {
    await store.recordUsage({
      day: snapshotDate,
      entityId: entity.id,
      endpointPath: "dataforseo_labs/google/domain_rank_overview/live",
      meteringClass: "paid_submission",
      blockedByBudget: true,
    });
    await store.finishJob(job.id, {
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

  // Live collection is deliberately NOT implemented in phase 1: the dedicated
  // credential does not exist, so this branch is unreachable in every deployed
  // configuration. Leaving it as an explicit refusal rather than a half-written
  // provider call means the first person to add a credential gets a clear
  // failure telling them what to implement, instead of a silent partial result.
  await store.finishJob(job.id, {
    status: "skipped",
    skipReason: "live_collection_not_enabled",
  });
  return {
    entityId: entity.id,
    jobId: job.id,
    status: "skipped",
    snapshotId: null,
    reason: "live_collection_not_enabled",
    costMicros: 0,
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
  topKeywords: unknown[];
  topPages: unknown[];
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
        topKeyword:
          (o.topKeywords[0] as { keyword?: string } | undefined)?.keyword ??
          null,
        topPage: (o.topPages[0] as { url?: string } | undefined)?.url ?? null,
        freshness: o.freshness,
      };
    }),
    visibility,
  };
}

interface CostStatus {
  costCentre: string;
  providerStatus: ProviderStatus;
  paidCallsEnabled: boolean;
  level: BudgetLevel;
  monthlyPercent: number;
  requests: number;
  meteredRequests: number;
  freeRequests: number;
  paidSubmissions: number;
  freePollRequests: number;
  resultFetchRequests: number;
  failedRequests: number;
  retryRequests: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  dailyCostUsd: number;
  dailyCostCapUsd: number;
  monthlyCostCapUsd: number;
  budgetRemainingUsd: number;
  projectedMonthEndCostUsd: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number | null;
  blockedByBudget: number;
  unexpectedSpendDetected: boolean;
  pendingAlertThreshold: number | null;
}

export async function costStatus(
  config: Phase0Config,
  env: object,
  now: Date = new Date(),
): Promise<CostStatus> {
  const day = store.snapshotDateFor(now);
  const month = monthOf(day);
  const [totals, dayTotals, state] = await Promise.all([
    store.ledgerTotals(month),
    store.ledgerTotals(day),
    store.readBudgetState(month),
  ]);
  const monthlyCap = config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD;
  const monthlyPercent =
    monthlyCap > 0 ? (totals.actualCostMicros / monthlyCap) * 100 : 0;
  const paidCallsEnabled = isEnabled(
    config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED,
  );
  const cacheTotal = totals.cacheHits + totals.cacheMisses;

  return {
    costCentre: "dataforseo_search_intelligence",
    providerStatus: resolveProviderStatus(config, env),
    paidCallsEnabled,
    level: levelFor(monthlyPercent),
    monthlyPercent,
    requests: totals.requests,
    meteredRequests: totals.meteredRequests,
    // Free calls are reported separately and never ration paid work.
    freeRequests: Math.max(0, totals.requests - totals.meteredRequests),
    paidSubmissions: totals.paidSubmissions,
    freePollRequests: totals.freePollRequests,
    resultFetchRequests: totals.resultFetchRequests,
    failedRequests: totals.failedRequests,
    retryRequests: totals.retryRequests,
    estimatedCostUsd: microsToUsd(totals.estimatedCostMicros),
    actualCostUsd: microsToUsd(totals.actualCostMicros),
    dailyCostUsd: microsToUsd(dayTotals.actualCostMicros),
    dailyCostCapUsd: microsToUsd(config.SEO_DATAFORSEO_DAILY_COST_CAP_USD),
    monthlyCostCapUsd: microsToUsd(monthlyCap),
    budgetRemainingUsd: microsToUsd(
      Math.max(0, monthlyCap - totals.actualCostMicros),
    ),
    projectedMonthEndCostUsd: microsToUsd(
      projectMonthEndMicros(totals.actualCostMicros, now),
    ),
    cacheHits: totals.cacheHits,
    cacheMisses: totals.cacheMisses,
    cacheHitRate: cacheTotal > 0 ? totals.cacheHits / cacheTotal : null,
    blockedByBudget: totals.blockedByBudget,
    unexpectedSpendDetected: detectUnexpectedSpend(
      paidCallsEnabled,
      totals.meteredRequests,
      totals.actualCostMicros,
    ),
    pendingAlertThreshold: crossedThreshold(
      monthlyPercent,
      state.lastAlertThreshold,
    ),
  };
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}
