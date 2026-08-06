import { sql } from "drizzle-orm";
import { db } from "@/db";
import { type Phase0Config } from "../phase0-env";
import type { ReadinessFacts } from "./rollout-readiness";

/**
 * Morgana Search Intelligence — readiness read from the database, not asserted.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P16).
 *
 * Every number here answers "has this actually happened", and each one is a
 * COUNT over rows a provider produced. Nothing consults a feature flag: a flag
 * says what is switched on, which is a different question from what works, and
 * conflating the two is how a subsystem reports itself ready on the strength of
 * its own configuration.
 *
 * Free and read-only. It creates nothing and calls no provider.
 */
async function countRows(table: string, where: string): Promise<number> {
  try {
    const rows = await db.all<{ n: number }>(
      sql.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`),
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    // A table that does not exist yet means the capability has produced
    // nothing, which is exactly what a zero says here. Throwing would make a
    // read-only diagnostic fail on a partially migrated database.
    return 0;
  }
}

export async function readinessFacts(
  config: Phase0Config,
  spend: {
    dailyActualMicros: number;
    overDailyCap: boolean;
    reconciliationPending: number;
    unexpectedSpendDetected: boolean;
    perCollector: { collector: string; actualMicros: number }[];
  },
  trackedKeywords: number,
): Promise<ReadinessFacts> {
  const [
    domainOverviewSnapshots,
    rankObservations,
    keywordsWithVolume,
    siteAuditRuns,
    backlinkSnapshotsLive,
    backlinkCompetitorSnapshots,
    aiObservationsLive,
  ] = await Promise.all([
    // `source`/`provider` is the discriminator everywhere: a row that came from
    // a provider counts, a fixture does not.
    countRows("domain_snapshots", "source = 'dataforseo'"),
    countRows("si_rank_snapshots", "provider = 'dataforseo'"),
    countRows("tracked_keywords", "search_volume IS NOT NULL"),
    countRows("si_site_audit_runs", "1 = 1"),
    countRows("si_backlink_snapshots", "source = 'dataforseo'"),
    countRows(
      "si_backlink_snapshots",
      "source = 'dataforseo' AND entity_id <> (SELECT id FROM search_entities WHERE entity_type = 'primary' LIMIT 1)",
    ),
    countRows("si_ai_observations", "source = 'dataforseo'"),
  ]);

  const costOf = (collector: string): number | null => {
    const row = spend.perCollector.find((c) => c.collector === collector);
    // 0 means "nothing recorded", which for a provider cost is an absence
    // rather than a measurement of free.
    return row && row.actualMicros > 0 ? row.actualMicros : null;
  };

  return {
    domainOverviewSnapshots,
    rankObservations,
    keywordsWithVolume,
    keywordsTracked: trackedKeywords,
    siteAuditRuns,
    backlinkSnapshotsLive,
    backlinkCompetitorSnapshots,
    aiObservationsLive,
    // Share of Search needs half the keywords with a known volume to have a
    // position. One of six does not clear that, and the metric says so itself.
    shareOfSearchComputable:
      keywordsWithVolume > 0 && rankObservations / keywordsWithVolume >= 0.5,
    measuredCostMicros: {
      domain_overview: costOf("domain_overview"),
      ranking: costOf("phase2"),
      keyword_volume: costOf("phase2"),
      backlinks: costOf("backlinks"),
    },
    overDailyCap: spend.overDailyCap,
    reconciliationPending: spend.reconciliationPending,
    unexpectedSpendDetected: spend.unexpectedSpendDetected,
    // Read from the parsed config's own diagnostic rather than from the raw
    // values, so no webhook string can reach this object.
    webhooksInvalid: invalidWebhookChannels(config),
  };
}

/**
 * Which alert channels hold an unusable webhook.
 *
 * Names only. The engine never sees Morgana's webhook values — they live in
 * Morgana's config — so this reports the channels this deploy knows are
 * unconfigured rather than inspecting anything secret.
 */
function invalidWebhookChannels(config: Phase0Config): string[] {
  // The engine has no webhook of its own; Morgana owns delivery. What it can
  // state honestly is that alerts are off, which is why nothing is delivered.
  return config.SEARCH_INTELLIGENCE_ENVIRONMENT === "production"
    ? ["intel", "brand_protection", "security"]
    : [];
}
