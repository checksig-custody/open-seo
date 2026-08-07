import { envelope, json, num, readJson } from "./http";
import * as keywordVolumes from "./keyword-volume-service";
import * as p2service from "./p2-service";
import { expireStaleReservations, globalSpend } from "./budget-authority";
import { holdingReservations } from "./budget-reservations";
import * as p2Store from "./p2-store";
import { capabilityMatrix, evaluateReleaseGate } from "./rollout-readiness";
import { dryRunSchedule, proposedPolicy } from "./scheduler-dry-run";
import { readinessFacts } from "./readiness-facts";
import * as keywordVolumeStore from "./keyword-volume-store";
import type { SiRequestContext } from "./router";

/**
 * Morgana Search Intelligence — the keyword-volume surface.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Split from `p2-router.ts` for size, and the split falls in a sensible place:
 * one route spends money to measure volumes, the other reads what was measured.
 */
export async function dispatchKeywordVolume(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, config, env, providerStatus } = ctx;
  const method = request.method;

  // Collect the search volumes the whole of phase 2 weights by. A paid provider
  // call, so it answers to the same pre-flight as buying a ranking.
  if (route === "keyword-volume-refresh" && method === "POST") {
    const body = await readJson(request);
    const ids = Array.isArray(body.tracked_keyword_ids)
      ? body.tracked_keyword_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;
    const result = await keywordVolumes.refreshKeywordVolumes(config, env, {
      providerStatus,
      limit: num(body.limit) ?? 50,
      trackedKeywordIds: ids,
    });

    // A measured volume changes the gap and the opportunity score for that
    // keyword, so the derived rows are refreshed here rather than left stale
    // until the next rank tick. Free — it reads observations already stored.
    const recomputed =
      result.withVolume > 0
        ? await p2service.recomputeAfterVolumeChange(
            config,
            result.recomputeKeywordIds,
          )
        : { keywords: 0, eventsDetected: 0 };

    return json(
      envelope(config, { ...result, recomputed }, { providerStatus }),
    );
  }

  // Recompute the gap and the opportunity scores from data already stored.
  //
  // Free, and separate from the collection that pays: a volume measured earlier,
  // a CTR model change or a correction all invalidate the derived rows without
  // anybody needing to buy anything. Without this the only way to refresh them
  // would be to spend money again, which is a bad reason to make a paid call.
  if (route === "gap-recompute" && method === "POST") {
    const keywords = await keywordVolumeStore.trackedKeywordIds();
    const result = await p2service.recomputeAfterVolumeChange(config, keywords);
    return json(envelope(config, result, { providerStatus }));
  }

  // The whole subsystem's budget, in one place. Free: it reads persisted rows
  // and reconciles reservations whose process died — which are NOT released,
  // because we cannot know whether the provider charged for them.
  if (route === "budget" && method === "GET") {
    const reconciled = await expireStaleReservations();
    const spend = await globalSpend(config);
    return json(envelope(config, { ...spend, reconciled }, { providerStatus }));
  }

  // Which reservations are holding capacity, and what it would take to settle
  // them. Free and read-only. `GET budget` reports `reconciliation_pending` as
  // a bare count, so this is the difference between knowing that something is
  // stuck and being able to go and unstick it.
  if (route === "budget/reservations" && method === "GET") {
    const reservations = await holdingReservations();
    return json(
      envelope(
        config,
        {
          reservations,
          holding_micros: reservations.reduce(
            (sum, row) => sum + row.estimatedMaxCostMicros,
            0,
          ),
          // Stated rather than implied: a reconciliation needs all three, and
          // the resolver refuses without them.
          resolution_requires: [
            "exact provider-verified cost in micro-USD",
            "evidence the cost was verified against",
            "actor",
          ],
        },
        { providerStatus },
      ),
    );
  }

  // Release readiness: what is built, what a provider has actually served, what
  // has enough data to say anything, and what a human still has to decide.
  // Read-only and free — it creates no job, takes no reservation and calls no
  // provider, which is what makes it safe to ask at any time.
  if (route === "readiness" && method === "GET") {
    const spend = await globalSpend(config);
    const trackedKeywords = await p2Store.listTrackedKeywords();
    const facts = await readinessFacts(config, spend, trackedKeywords.length);
    const matrix = capabilityMatrix(config, facts);
    const gate = evaluateReleaseGate(matrix, facts);
    const policy = proposedPolicy({
      criticalKeywords: trackedKeywords.filter((k) => k.priority === "critical")
        .length,
      highKeywords: trackedKeywords.filter((k) => k.priority === "high").length,
      entities: facts.domainOverviewSnapshots,
    });
    const forecast = dryRunSchedule(
      {
        criticalKeywords: 0,
        highKeywords: 0,
        entities: 0,
        policy,
      },
      {
        dailyMicros: spend.dailyCapMicros,
        monthlyMicros: spend.monthlyCapMicros,
      },
    );
    return json(
      envelope(
        config,
        {
          capabilities: matrix,
          gate,
          // The proposed cadence, priced, with every entry still disabled.
          scheduler_dry_run: forecast,
          budget: {
            daily_actual_micros: spend.dailyActualMicros,
            monthly_actual_micros: spend.monthlyActualMicros,
            open_reservations_micros: spend.openReservationsMicros,
            daily_cap_micros: spend.dailyCapMicros,
            over_daily_cap: spend.overDailyCap,
            per_collector: spend.perCollector,
            reconciliation_pending: spend.reconciliationPending,
            unexpected_spend_detected: spend.unexpectedSpendDetected,
          },
          // Logical channel and state only — never a URL, valid or not.
          webhooks: facts.webhooksInvalid.map((channel) => ({
            channel,
            configured: false,
            state: "webhook_invalid_configuration",
            delivery: "suppressed",
          })),
        },
        { providerStatus },
      ),
    );
  }

  // What was measured, when, and whether the provider actually answered.
  if (route === "keyword-volumes" && method === "GET") {
    const rows = await keywordVolumeStore.latestVolumeSnapshots(100);
    return json(
      envelope(
        config,
        {
          snapshots: rows.map((row) => ({
            tracked_keyword_id: row.trackedKeywordId,
            keyword: row.keyword,
            location_code: row.locationCode,
            language_code: row.languageCode,
            search_engine: row.searchEngine,
            search_volume: row.searchVolume,
            competition: row.competition,
            competition_level: row.competitionLevel,
            cost_per_click_micros: row.costPerClickMicros,
            keyword_difficulty: row.keywordDifficulty,
            search_intent: row.searchIntent,
            provider: row.provider,
            source: row.source,
            collected_at: row.collectedAt,
            collection_window: row.collectionWindow,
            snapshot_status: row.snapshotStatus,
            snapshot_status_reason: row.snapshotStatusReason,
          })),
        },
        { providerStatus },
      ),
    );
  }

  return null;
}
