import { type Phase0Config } from "../phase0-env";
import { type CollectionAccounting } from "./collection-accounting";
import * as ledger from "./ledger-store";
import * as p2 from "./p2-store";
import {
  collectKeywordVolumes,
  KEYWORD_OVERVIEW_ENDPOINT,
  WORST_CASE_OVERVIEW_MICROS,
} from "./keyword-volume-collector";
import * as volumes from "./keyword-volume-store";
import { logRankFailure } from "./rank-errors";
import { rankPreflight } from "./rank-preflight";

/**
 * Morgana Search Intelligence — collecting the search volumes phase 2 weights by.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Keyword Gap ranks opportunities by volume and Share of Search weights by it,
 * so without volumes both refuse to answer: every opportunity score is null and
 * the share reports `insufficient_data`. This closes that gap with a measurement
 * rather than a guess.
 *
 * ONE REQUEST FOR THE WHOLE BATCH — Labs prices Keyword Overview per request —
 * and therefore one authorisation, one ledger entry and one cost for the set.
 *
 * The pre-flight is the SAME one the SERP submission uses: this is a paid
 * provider call, so it answers to production, the credential, the paid-calls
 * flag, both caps and the worst-case headroom exactly as buying a ranking does.
 * Reusing it is the point — a second spend gate is a second thing to get wrong.
 */

interface VolumeRefreshResult {
  status: "collected" | "refused" | "failed" | "nothing_due";
  reason: string;
  /** Keywords the provider was asked about. */
  requested: number;
  /** Keywords it answered about. */
  answered: number;
  /** Measurements written. A repeat in the same window writes none. */
  stored: number;
  /** Answers carrying a usable volume (including a real zero). */
  withVolume: number;
  /** Answers where the provider holds no volume — never counted as zero. */
  noData: number;
  costMicros: number;
  costStatus: CollectionAccounting["costStatus"];
  source: "dataforseo" | null;
  /** Keywords whose volume changed, and whose derived rows are now stale. */
  recomputeKeywordIds: string[];
}

const empty = (
  status: VolumeRefreshResult["status"],
  reason: string,
): VolumeRefreshResult => ({
  status,
  reason,
  requested: 0,
  answered: 0,
  stored: 0,
  withVolume: 0,
  noData: 0,
  costMicros: 0,
  costStatus: "zero",
  source: null,
  recomputeKeywordIds: [],
});

/**
 * Collect volumes for the tracked watchlist.
 *
 * `limit` bounds how many keywords are asked about, which bounds nothing about
 * cost — the request is flat-priced — but keeps a first live run small and
 * inspectable.
 */
export async function refreshKeywordVolumes(
  config: Phase0Config,
  env: object,
  options: {
    /**
     * The engine-wide provider status. Anything other than a plain
     * `not_configured` / `fixture` / `live` (a breaker or an exhausted budget)
     * is refused by the pre-flight rather than reinterpreted here.
     */
    providerStatus: string;
    limit?: number;
    /** Restrict to specific keywords; used to keep a live proof minimal. */
    trackedKeywordIds?: readonly string[];
    now?: Date;
  },
): Promise<VolumeRefreshResult> {
  const now = options.now ?? new Date();
  const window = now.toISOString().slice(0, 10);

  const [dayTotals, monthTotals] = await Promise.all([
    ledger.ledgerTotals(window),
    ledger.ledgerTotals(window.slice(0, 7)),
  ]);
  const status = options.providerStatus;
  const preflight = rankPreflight({
    config,
    providerStatus:
      status === "live" || status === "fixture" ? status : "not_configured",
    dailySpentMicros: dayTotals.actualCostMicros,
    monthlySpentMicros: monthTotals.actualCostMicros,
    worstCaseCostMicros: WORST_CASE_OVERVIEW_MICROS,
  });
  if (!preflight.ok) {
    // No call, no snapshot, no cost, and above all no fixture volume: a
    // synthetic number here would propagate straight into an opportunity score
    // and a share, where nothing could tell it from a measurement.
    logRankFailure({ trackedKeywordId: null, taskId: null }, preflight.failure);
    return empty("refused", `VOLUME_PREFLIGHT_FAILED:${preflight.reason}`);
  }

  const tracked = await p2.listTrackedKeywords();
  const selected = tracked
    .filter((k) =>
      options.trackedKeywordIds
        ? options.trackedKeywordIds.includes(k.id)
        : k.trackingEnabled,
    )
    .slice(0, options.limit ?? 50);
  if (selected.length === 0) return empty("nothing_due", "no tracked keyword");

  // One market per request: volume is market-specific, so mixing locations in a
  // single call would attribute one market's number to another's keyword.
  const market = {
    locationCode: selected[0].locationCode,
    languageCode: selected[0].languageCode,
  };
  const batch = selected.filter(
    (k) =>
      k.locationCode === market.locationCode &&
      k.languageCode === market.languageCode,
  );

  const outcome = await collectKeywordVolumes({
    keywords: batch.map((k) => k.keyword),
    locationCode: market.locationCode,
    languageCode: market.languageCode,
  });

  // LEDGER FIRST, as everywhere in this engine: the call has happened and may
  // be billed, so a failure to store measurements must lose the measurements,
  // never the record of the money.
  await ledger.recordUsage({
    day: window,
    entityId: "keyword_volume",
    jobId: null,
    endpointPath:
      outcome.status === "completed"
        ? outcome.endpoint
        : KEYWORD_OVERVIEW_ENDPOINT,
    meteringClass: "paid_submission",
    costStatus: outcome.accounting.costStatus,
    actualCostMicros:
      outcome.accounting.costStatus === "not_reported"
        ? undefined
        : outcome.accounting.actualCostMicros,
    estimatedCostMicros:
      outcome.accounting.costStatus === "not_reported"
        ? undefined
        : outcome.accounting.estimatedCostMicros,
    failed: outcome.status === "failed",
  });

  if (outcome.status === "failed") {
    logRankFailure({ trackedKeywordId: null, taskId: null }, outcome.failure);
    return {
      ...empty("failed", outcome.failure.code),
      requested: batch.length,
      costMicros: 0,
      costStatus: outcome.accounting.costStatus,
    };
  }

  const byKeyword = new Map(batch.map((k) => [k.keyword.toLowerCase(), k]));
  const recomputeKeywordIds: string[] = [];
  let stored = 0;
  let withVolume = 0;
  let noData = 0;

  for (const row of outcome.rows) {
    const keyword = byKeyword.get(row.keyword.toLowerCase());
    if (!keyword) continue;

    const snapshot = await volumes.saveVolumeSnapshot({
      trackedKeywordId: keyword.id,
      keyword: keyword.keyword,
      locationCode: keyword.locationCode,
      languageCode: keyword.languageCode,
      searchEngine: "google",
      searchVolume: row.searchVolume,
      competition: row.competition,
      competitionLevel: row.competitionLevel,
      costPerClickMicros: row.costPerClickMicros,
      keywordDifficulty: row.keywordDifficulty,
      searchIntent: row.searchIntent,
      provider: "dataforseo",
      source: "dataforseo",
      collectedAt: now.toISOString(),
      collectionWindow: window,
      snapshotStatus: row.snapshotStatus,
      snapshotStatusReason: row.snapshotStatusReason,
      jobId: null,
      providerResponseId: null,
    });
    if (snapshot.created) stored += 1;

    if (row.searchVolume === null) {
      noData += 1;
      continue;
    }
    withVolume += 1;
    recomputeKeywordIds.push(keyword.id);
    // Only a stated volume reaches the read model. A zero is written as zero —
    // it is a measurement — while an absent one leaves the previous best answer
    // in place rather than erasing it.
    await volumes.updateKeywordVolume(keyword.id, row.searchVolume);
  }

  return {
    status: "collected",
    reason: "collected",
    requested: batch.length,
    answered: outcome.rows.length,
    stored,
    withVolume,
    noData,
    costMicros: outcome.accounting.actualCostMicros,
    costStatus: outcome.accounting.costStatus,
    source: "dataforseo",
    recomputeKeywordIds,
  };
}
