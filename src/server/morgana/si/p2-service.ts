import { isEnabled, type Phase0Config } from "../phase0-env";
import { microsToUsd } from "./budget";
import { classifyGap, computeShareOfSearch, CTR_MODEL_VERSION } from "./gap";
import { detectRankingEvents, detectShareShift } from "./events";
import { priorityWeight, type Priority } from "./keywords";
import * as p2 from "./p2-store";
import * as p2an from "./p2-analytics-store";
import * as p2jobs from "./p2-jobs-store";
import * as store from "./store";
import { resolveProviderStatus } from "./service";

/**
 * Morgana Search Intelligence — phase 2 orchestration.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Wires the pure logic to the store. As in phase 1, the engine has no cron:
 * Morgana's scheduler calls `runRankTick`, so the engine still cannot spend
 * unless asked.
 */

const today = (now: Date = new Date()) => now.toISOString().slice(0, 10);

/** Deterministic fixture rank, so the whole pipeline runs without a credential. */
function fixtureRank(
  keyword: string,
  domain: string,
  date: string,
): number | null {
  let h = 2166136261;
  for (const ch of `${keyword}|${domain}|${date}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const v = Math.abs(h) % 100;
  // Roughly a quarter of keyword/domain pairs do not rank at all — the case the
  // UI and the maths must handle, so the fixtures must produce it.
  if (v >= 75) return null;
  return 1 + (v % 40);
}

interface RankTickResult {
  due: number;
  processed: number;
  observationsRecorded: number;
  eventsDetected: number;
  provider: string;
  skipped?: string;
}

/**
 * One scheduler step: check the most urgent due keywords against every enabled
 * entity, store the observations, then classify the gap and detect events.
 *
 * Bounded per tick so a single invocation cannot exhaust the subrequest budget
 * or the daily cap in one burst.
 */
export async function runRankTick(
  config: Phase0Config,
  env: object,
  options: { limit?: number; now?: Date } = {},
): Promise<RankTickResult> {
  const now = options.now ?? new Date();
  const date = today(now);
  const provider = resolveProviderStatus(config, env);

  if (provider === "not_configured") {
    return {
      due: 0,
      processed: 0,
      observationsRecorded: 0,
      eventsDetected: 0,
      provider,
      skipped: "credential_not_configured",
    };
  }
  if (provider === "live") {
    // Live SERP collection is not implemented in phase 2 — no credential exists
    // in any deployed configuration. An explicit refusal beats a half-written
    // provider call that would silently produce partial data.
    return {
      due: 0,
      processed: 0,
      observationsRecorded: 0,
      eventsDetected: 0,
      provider,
      skipped: "live_collection_not_enabled",
    };
  }

  const entities = await store.listEntities();
  const primary = entities.find((e) => e.entityType === "primary");
  if (!primary) {
    return {
      due: 0,
      processed: 0,
      observationsRecorded: 0,
      eventsDetected: 0,
      provider,
      skipped: "no_primary_entity",
    };
  }

  const due = await p2.dueKeywords(options.limit ?? 5, now);
  let observations = 0;
  let eventsDetected = 0;

  for (const keyword of due) {
    const job = await p2jobs.claimJob({
      jobType: "rank_check",
      trackedKeywordId: keyword.id,
      priority: keyword.priority,
      snapshotDate: date,
    });
    if (!job) continue;

    for (const entity of entities) {
      const rank = fixtureRank(
        keyword.normalizedKeyword,
        entity.normalizedDomain,
        date,
      );
      const recorded = await p2.recordRank({
        trackedKeywordId: keyword.id,
        entityId: entity.id,
        locationCode: keyword.locationCode,
        languageCode: keyword.languageCode,
        rankGroup: rank,
        rankAbsolute: rank === null ? null : rank + 2,
        rankingUrl:
          rank === null
            ? null
            : `https://${entity.normalizedDomain}/${keyword.normalizedKeyword.replace(/\s+/g, "-")}`,
        provider: "fixture",
        now,
      });
      if (recorded) observations += 1;
    }

    const dates = await p2.recentSnapshotDates(keyword.id, 3);
    const current = await p2.observationsFor(keyword.id, date);
    const previous = dates[1]
      ? await p2.observationsFor(keyword.id, dates[1])
      : undefined;
    const beforePrevious = dates[2]
      ? await p2.observationsFor(keyword.id, dates[2])
      : undefined;

    const gap = classifyGap({
      primaryEntityId: primary.id,
      current,
      previous,
      searchVolume: keyword.searchVolume,
    });
    await p2an.saveGapSnapshot({
      trackedKeywordId: keyword.id,
      snapshotDate: date,
      category: gap.category,
      primaryRank: gap.primaryRank,
      bestCompetitorRank: gap.bestCompetitorRank,
      bestCompetitorEntityId: gap.bestCompetitorEntityId,
      opportunityScore: gap.opportunityScore,
    });

    if (
      keyword.alertingEnabled &&
      isEnabled(config.SEARCH_INTELLIGENCE_ENABLED)
    ) {
      const events = detectRankingEvents({
        trackedKeywordId: keyword.id,
        primaryEntityId: primary.id,
        priority: keyword.priority,
        snapshotDate: date,
        current,
        previous,
        beforePrevious,
      });
      eventsDetected += (await p2an.saveEvents(events)).length;
    }

    await p2.markChecked(keyword.id, keyword.trackingFrequencyHours, now);
    await p2jobs.finishJob(job.id, "succeeded");
  }

  await p2jobs.recordPhase2Usage({
    day: date,
    jobType: "rank_check",
    // Fixtures make no HTTP call and cost nothing; they are counted as cache
    // hits so the ledger still reflects the work done.
    cacheHits: observations,
    keywordsChecked: due.length,
  });

  return {
    due: due.length,
    processed: due.length,
    observationsRecorded: observations,
    eventsDetected,
    provider,
  };
}

/** Recompute Tracked Keyword Share of Search for today, overall and per cluster. */
export async function recalculateShareOfSearch(
  options: { now?: Date } = {},
): Promise<{ status: string; entities: number; clusters: number }> {
  const now = options.now ?? new Date();
  const date = today(now);
  const entities = await store.listEntities();
  const entityIds = entities.map((e) => e.id);
  const keywords = await p2.listTrackedKeywords();
  const clusters = await p2.listClusters();
  const clusterWeight = new Map(clusters.map((c) => [c.id, c.weight]));

  const withObservations = await Promise.all(
    keywords.map(async (k) => ({
      trackedKeywordId: k.id,
      clusterId: k.clusterId,
      searchVolume: k.searchVolume,
      clusterWeight: k.clusterId ? (clusterWeight.get(k.clusterId) ?? 1) : 1,
      priorityWeight: priorityWeight(k.priority as Priority),
      observations: await p2.observationsFor(k.id, date),
    })),
  );

  const overall = computeShareOfSearch(withObservations, entityIds);
  for (const result of overall.results) {
    await p2an.saveShareSnapshot({
      entityId: result.entityId,
      clusterId: null,
      snapshotDate: date,
      visibilityScore: result.visibilityScore,
      share: result.share,
      status: overall.status,
      reason: overall.reason,
      keywordsConsidered: overall.keywordsConsidered,
      keywordsCovered: overall.keywordsCovered,
      ctrModelVersion: CTR_MODEL_VERSION,
    });
  }

  let clusterCount = 0;
  for (const cluster of clusters) {
    const subset = withObservations.filter((k) => k.clusterId === cluster.id);
    if (subset.length === 0) continue;
    const result = computeShareOfSearch(subset, entityIds);
    for (const row of result.results) {
      await p2an.saveShareSnapshot({
        entityId: row.entityId,
        clusterId: cluster.id,
        snapshotDate: date,
        visibilityScore: row.visibilityScore,
        share: row.share,
        status: result.status,
        reason: result.reason,
        keywordsConsidered: result.keywordsConsidered,
        keywordsCovered: result.keywordsCovered,
        ctrModelVersion: CTR_MODEL_VERSION,
      });
    }
    clusterCount += 1;
  }

  // A material move in overall share is itself alert-worthy.
  const history = await p2an.shareHistory(
    new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10),
  );
  for (const result of overall.results) {
    const prior = history
      .filter(
        (h) =>
          h.entityId === result.entityId &&
          h.clusterId === null &&
          h.snapshotDate < date,
      )
      .at(-1);
    const event = detectShareShift({
      entityId: result.entityId,
      previousShare: prior?.share ?? null,
      currentShare: result.share,
      snapshotDate: date,
    });
    if (event) await p2an.saveEvents([event]);
  }

  return {
    status: overall.status,
    entities: overall.results.length,
    clusters: clusterCount,
  };
}

interface Phase2CostStatus {
  costCentre: string;
  providerStatus: string;
  httpRequests: number;
  meteredRequests: number;
  paidTasks: number;
  keywordsChecked: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number | null;
  estimatedCostUsd: number;
  actualCostUsd: number;
  dailyCostUsd: number;
  costPerKeywordCheckUsd: number | null;
  monthlyForecastUsd: number;
  budgetRemainingUsd: number;
  monthlyCapUsd: number;
  dailyCapUsd: number;
  blockedByBudget: number;
}

export async function phase2CostStatus(
  config: Phase0Config,
  env: object,
  now: Date = new Date(),
): Promise<Phase2CostStatus> {
  const day = today(now);
  const month = day.slice(0, 7);
  const [monthTotals, dayTotals] = await Promise.all([
    p2jobs.phase2Totals(month),
    p2jobs.phase2Totals(day),
  ]);
  const cacheTotal = monthTotals.cacheHits + monthTotals.cacheMisses;
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const monthlyCap = config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD;

  return {
    // Distinct from phase 1 on purpose: "what is rank tracking costing us"
    // must be answerable without subtracting one ledger from another.
    costCentre: "dataforseo_search_intelligence_p2",
    providerStatus: resolveProviderStatus(config, env),
    httpRequests: monthTotals.httpRequests,
    meteredRequests: monthTotals.meteredRequests,
    paidTasks: monthTotals.paidTasks,
    keywordsChecked: monthTotals.keywordsChecked,
    cacheHits: monthTotals.cacheHits,
    cacheMisses: monthTotals.cacheMisses,
    cacheHitRate: cacheTotal > 0 ? monthTotals.cacheHits / cacheTotal : null,
    estimatedCostUsd: microsToUsd(monthTotals.estimatedCostMicros),
    actualCostUsd: microsToUsd(monthTotals.actualCostMicros),
    dailyCostUsd: microsToUsd(dayTotals.actualCostMicros),
    costPerKeywordCheckUsd:
      monthTotals.keywordsChecked > 0
        ? microsToUsd(
            Math.round(
              monthTotals.actualCostMicros / monthTotals.keywordsChecked,
            ),
          )
        : null,
    monthlyForecastUsd:
      monthTotals.actualCostMicros === 0
        ? 0
        : microsToUsd(
            Math.round(
              (monthTotals.actualCostMicros / dayOfMonth) * daysInMonth,
            ),
          ),
    budgetRemainingUsd: microsToUsd(
      Math.max(0, monthlyCap - monthTotals.actualCostMicros),
    ),
    monthlyCapUsd: microsToUsd(monthlyCap),
    dailyCapUsd: microsToUsd(config.SEO_DATAFORSEO_DAILY_COST_CAP_USD),
    blockedByBudget: monthTotals.blockedByBudget,
  };
}
