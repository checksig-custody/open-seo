import { type Phase0Config } from "../phase0-env";
import { microsToUsd } from "./budget";
import { computeShareOfSearch, CTR_MODEL_VERSION } from "./gap";
import { detectShareShift } from "./events";
import { priorityWeight, type Priority } from "./keywords";
import * as p2 from "./p2-store";
import * as p2an from "./p2-analytics-store";
import * as p2jobs from "./p2-jobs-store";
import * as store from "./store";
import * as ledger from "./ledger-store";
import { resolveProviderStatus } from "./service";
import { collectReadyRankTasks, submitDueRankTask } from "./rank-live-service";
import { recomputeDerivedState } from "./p2-derived";

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
  /** Live lifecycle, absent in fixture mode. */
  submitted?: number;
  duplicates?: number;
  refused?: number;
  collected?: number;
  pending?: number;
  failed?: number;
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
  options: { limit?: number; collectLimit?: number; now?: Date } = {},
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
  // A PRODUCTION ENGINE NEVER MANUFACTURES A FIXTURE RANKING.
  //
  // Phase 1 refuses this in `refreshEntity`; the rank tick did not, and a
  // production tick with spend switched off wrote five synthetic positions into
  // the production database. A fixture rank is worse than a fixture metric: it
  // is a number a human would act on, and nothing reading D1 afterwards can
  // tell it from a measurement.
  if (
    provider === "fixture" &&
    config.SEARCH_INTELLIGENCE_ENVIRONMENT === "production"
  ) {
    return {
      due: 0,
      processed: 0,
      observationsRecorded: 0,
      eventsDetected: 0,
      provider,
      skipped: "fixture_refused_in_production",
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
  let submitted = 0;
  let duplicates = 0;
  let refused = 0;

  // LIVE: collect first, then submit.
  //
  // Collection is free and finishes work already paid for, so it must never be
  // crowded out by new spending — and a tick that submits first would be one
  // tick slower to turn every receipt into data.
  let collected: Awaited<ReturnType<typeof collectReadyRankTasks>> | null =
    null;
  if (provider === "live") {
    collected = await collectReadyRankTasks({
      entities,
      day: date,
      limit: options.collectLimit ?? 10,
      now,
    });
    observations += collected.observations;
  }

  for (const keyword of due) {
    const job = await p2jobs.claimJob({
      jobType: "rank_check",
      trackedKeywordId: keyword.id,
      priority: keyword.priority,
      snapshotDate: date,
    });
    if (!job) continue;

    if (provider === "live") {
      // ONE SUBMISSION PER KEYWORD, not per entity. The SERP that answers "where
      // is CheckSig" answers "where is every competitor" at the same time, so
      // buying one per tracked entity would pay five times for one page. The
      // primary entity only supplies the target domain on the request.
      //
      // Spend is re-read from the ledger for each submission rather than once
      // per tick: every submission moves the daily total, and a cap checked
      // only at the top of a loop is a cap the loop walks straight past.
      const [dayTotals, monthTotals] = await Promise.all([
        ledger.ledgerTotals(date),
        ledger.ledgerTotals(date.slice(0, 7)),
      ]);
      const outcome = await submitDueRankTask({
        config,
        providerStatus: provider,
        entity: primary,
        keyword: {
          id: keyword.id,
          keyword: keyword.keyword,
          locationCode: keyword.locationCode,
          languageCode: keyword.languageCode,
        },
        jobId: job.id,
        day: date,
        dailySpentMicros: dayTotals.actualCostMicros,
        monthlySpentMicros: monthTotals.actualCostMicros,
        now,
      });
      if (outcome.status === "submitted") submitted += 1;
      if (outcome.status === "duplicate") duplicates += 1;
      if (outcome.status === "refused") refused += 1;
    } else {
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
    }

    // DERIVED STATE FOLLOWS THE OBSERVATION, NOT THE REQUEST.
    //
    // In fixture mode the rank exists the moment it is asked for, so the gap
    // and the events can be recomputed here. Live, a submission has bought a
    // SERP that has not arrived: recomputing now would classify the keyword
    // against yesterday's data and — worse — `markChecked` would push its next
    // due time forward for work that has not happened. Live keywords are
    // recomputed below, once collection has actually produced an observation.
    if (provider !== "live") {
      eventsDetected += await recomputeDerivedState({
        config,
        primaryId: primary.id,
        keyword,
        date,
        now,
      });
      await p2.markChecked(keyword.id, keyword.trackingFrequencyHours, now);
    }
    await p2jobs.finishJob(job.id, "succeeded");
  }

  // Live: everything that a collection actually delivered this tick.
  if (collected) {
    for (const keywordId of collected.keywordsTouched) {
      const keyword = await p2.getTrackedKeyword(keywordId);
      if (!keyword) continue;
      eventsDetected += await recomputeDerivedState({
        config,
        primaryId: primary.id,
        keyword,
        date,
        now,
      });
      await p2.markChecked(keyword.id, keyword.trackingFrequencyHours, now);
    }
  }

  await p2jobs.recordPhase2Usage({
    day: date,
    jobType: "rank_check",
    // Fixtures make no HTTP call and cost nothing; they are counted as cache
    // hits so the ledger still reflects the work done. Live spend is NOT
    // recorded here — it belongs to the shared ledger, keyed by job id, and a
    // second copy of the same money is a second thing that can drift.
    cacheHits: provider === "live" ? 0 : observations,
    paidTasks: submitted,
    keywordsChecked: due.length,
  });

  return {
    due: due.length,
    processed: due.length,
    observationsRecorded: observations,
    eventsDetected,
    provider,
    ...(provider === "live"
      ? {
          submitted,
          duplicates,
          refused,
          collected: collected?.collected ?? 0,
          pending: collected?.pending ?? 0,
          failed: collected?.failed ?? 0,
        }
      : {}),
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
