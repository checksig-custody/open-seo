import { type Phase0Config } from "../phase0-env";
import { microsToUsd } from "./budget";
import { computeShareOfSearch, CTR_MODEL_VERSION } from "./gap";
import { detectShareShift } from "./events";
import { priorityWeight, type Priority } from "./keywords";
import * as p2 from "./p2-store";
import * as p2an from "./p2-analytics-store";
import * as p2jobs from "./p2-jobs-store";
import * as store from "./store";
import { globalSpend } from "./budget-authority";
import { resolveProviderStatus } from "./service";
import { submitDueRankTask } from "./rank-live-service";
import { collectReadyRankTasks } from "./rank-collect-service";
import { recomputeDerivedState } from "./p2-derived";
import { recordFixtureRanks } from "./p2-fixtures";

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
 * Why a tick did nothing.
 *
 * Only ever set when the tick did NOTHING, because Morgana's scheduler returns
 * early on a skip: a collect-only tick that redeemed or advanced a task did real
 * work, and reporting it as skipped would strand the observation it just
 * collected before share of search ever saw it.
 *
 * A caller that asked for no submissions was not refused one, so collect-only is
 * reported as collect-only; `fixture_refused_in_production` is reserved for a
 * tick that actually wanted to submit and was not allowed to.
 */
function skipReasonFor(input: {
  dueCount: number;
  collectedAnything: boolean;
  submissionLimit: number;
  fixtureRefusedInProduction: boolean;
}): string | undefined {
  if (input.dueCount > 0 || input.collectedAnything) return undefined;
  if (input.submissionLimit === 0) return "collect_only_nothing_due";
  return input.fixtureRefusedInProduction
    ? "fixture_refused_in_production"
    : undefined;
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
  options: {
    limit?: number;
    collectLimit?: number;
    now?: Date;
    /** Restrict paid submissions to these keywords. See `dueKeywords`. */
    trackedKeywordIds?: readonly string[];
  } = {},
): Promise<RankTickResult> {
  const now = options.now ?? new Date();
  const date = today(now);
  const provider = resolveProviderStatus(config, env);

  // TWO AUTHORITIES, NOT ONE. `resolveProviderStatus` answers "may this engine
  // spend", and using that single answer to gate the whole tick was wrong:
  //
  //   task_post  buys a SERP           -> needs spend authority
  //   task_get   reads one already paid for -> needs a credential and a receipt
  //
  // With paid calls off the provider resolves to `fixture`, and the production
  // fixture guard below then refused the entire tick — including the free fetch
  // that collects a SERP the ledger already shows as bought. That left paid work
  // stranded behind a switch it does not use, and forced spend authority to be
  // turned on to retrieve something that costs nothing.
  const isProduction = config.SEARCH_INTELLIGENCE_ENVIRONMENT === "production";
  const submissionLimit = options.limit ?? 5;
  const collectLimit = options.collectLimit ?? 10;

  if (provider === "not_configured") {
    // The one condition that stops BOTH: with no credential there is nothing to
    // ask with, so a persisted receipt cannot be redeemed either.
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
  //
  // It now gates the SUBMISSION path only. Collection cannot manufacture
  // anything: it reads a stored `provider_task_id` from the real API or does
  // nothing at all.
  const fixtureRefusedInProduction = provider === "fixture" && isProduction;
  const canSubmit =
    submissionLimit > 0 && (provider === "live" || !fixtureRefusedInProduction);

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

  let observations = 0;
  let eventsDetected = 0;
  let submitted = 0;
  let duplicates = 0;
  let refused = 0;

  // COLLECT FIRST, AND ON ITS OWN TERMS.
  //
  // Free, so the budget does not gate it; already paid for, so spend authority
  // does not either. It needs a credential (checked above) and a task carrying
  // a receipt — `collectReadyRankTasks` refuses any row without one, which is
  // also what makes a fixture task uncollectable: fixtures never get a receipt.
  //
  // Before submission, because free work that finishes something already bought
  // must never be crowded out by new spending.
  let collected: Awaited<ReturnType<typeof collectReadyRankTasks>> | null =
    null;
  if (collectLimit > 0) {
    collected = await collectReadyRankTasks({
      entities,
      day: date,
      limit: collectLimit,
      now,
    });
    observations += collected.observations;
  }

  // `submissionLimit` of 0 is the collect-only mode, and it is enforced here
  // rather than trusted: no keyword is selected, so no code path below can
  // reach `task_post`.
  const due = canSubmit
    ? await p2.dueKeywords(submissionLimit, now, options.trackedKeywordIds)
    : [];
  const collectedAnything =
    collected !== null &&
    collected.collected + collected.pending + collected.failed > 0;

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
      // GLOBAL, not this ledger's. Reading only phase 2's spend is exactly the
      // mistake that let the day reach 0.21400 USD against a 0.20 cap: four
      // guards each gave a correct local answer and nobody held the total.
      const global = await globalSpend(config, { now });
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
        dailySpentMicros:
          global.dailyActualMicros + global.openReservationsMicros,
        monthlySpentMicros:
          global.monthlyActualMicros + global.openReservationsMicros,
        now,
      });
      if (outcome.status === "submitted") submitted += 1;
      if (outcome.status === "duplicate") duplicates += 1;
      if (outcome.status === "refused") refused += 1;
    } else {
      observations += await recordFixtureRanks({
        entities,
        keyword,
        date,
        now,
      });
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

  const skipped = skipReasonFor({
    dueCount: due.length,
    collectedAnything,
    submissionLimit,
    fixtureRefusedInProduction,
  });

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
    ...(skipped ? { skipped } : {}),
    // Reported whenever the live lifecycle was actually exercised — which now
    // includes a collect-only tick with spend switched off, the case that used
    // to be invisible.
    ...(provider === "live" || collected !== null
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
/**
 * Recompute what a new search volume changes.
 *
 * A volume is an input to the gap classification and to every opportunity
 * score, so measuring one invalidates yesterday's derived row for that keyword.
 * Recomputing here means the chain ends where the user reads it — a weighted
 * gap and a score — rather than one tick later. Free: no provider call, only
 * observations already stored.
 */
export async function recomputeAfterVolumeChange(
  config: Phase0Config,
  trackedKeywordIds: readonly string[],
  options: { now?: Date } = {},
): Promise<{ keywords: number; eventsDetected: number }> {
  const now = options.now ?? new Date();
  const date = today(now);
  const entities = await store.listEntities();
  const primary = entities.find((e) => e.entityType === "primary");
  if (!primary) return { keywords: 0, eventsDetected: 0 };

  let eventsDetected = 0;
  let touched = 0;
  for (const id of trackedKeywordIds) {
    const keyword = await p2.getTrackedKeyword(id);
    if (!keyword) continue;
    eventsDetected += await recomputeDerivedState({
      config,
      primaryId: primary.id,
      keyword,
      date,
      now,
    });
    touched += 1;
  }
  return { keywords: touched, eventsDetected };
}

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
      eligibleKeywords: overall.eligibleKeywords,
      excludedKeywords: overall.excludedKeywords,
      exclusionReasons: JSON.stringify(overall.exclusions),
      coverage: overall.coverage,
      calculatedAt: overall.calculatedAt,
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
        eligibleKeywords: result.eligibleKeywords,
        excludedKeywords: result.excludedKeywords,
        exclusionReasons: JSON.stringify(result.exclusions),
        coverage: result.coverage,
        calculatedAt: result.calculatedAt,
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
