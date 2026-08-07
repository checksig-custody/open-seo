import { sql } from "drizzle-orm";
import { db } from "@/db";
import { type Phase0Config } from "../phase0-env";
import { MIN_RANKING_COVERAGE, type ReadinessFacts } from "./rollout-readiness";

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

/** How many distinct things, not how many rows about them. */
async function countDistinct(
  table: string,
  column: string,
  where: string,
): Promise<number> {
  try {
    const rows = await db.all<{ n: number }>(
      sql.raw(
        `SELECT COUNT(DISTINCT ${column}) AS n FROM ${table} WHERE ${where}`,
      ),
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * The share of the eligible watchlist a fact covers.
 *
 * Null when nothing is eligible: a ratio with an empty denominator is not zero
 * coverage, it is an unanswerable question, and reporting it as 0 would present
 * "we track no keywords" as "we have measured none of them".
 */
function coverageOf(covered: number, eligible: number): number | null {
  return eligible > 0 ? covered / eligible : null;
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
    keywordsRanked,
    keywordsPositioned,
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
    // COUNT THE KEYWORDS, NOT THE ROWS. `si_rank_snapshots` holds one row per
    // keyword PER ENTITY per day, so a single keyword observed against CheckSig
    // and four competitors is five rows. Divided by a count of distinct
    // keywords that ratio is not a coverage at all — and in production on
    // 2026-08-07 it read 5/6 = 0.83 while exactly one keyword of six had ever
    // been measured. The gate believed Share of Search could compute; the
    // metric itself refused. Two populations, one fraction.
    countDistinct(
      "si_rank_snapshots",
      "tracked_keyword_id",
      "provider = 'dataforseo'",
    ),
    // A POSITION, not merely a measurement. This is the numerator Share of
    // Search actually needs and it matches `computeShareOfSearch`'s own
    // definition of "covered" — a found result with a rank group. A real
    // not-found is a valid observation, but there is no position to weight, so
    // it cannot contribute to a share.
    countDistinct(
      "si_rank_snapshots",
      "tracked_keyword_id",
      "provider = 'dataforseo' AND is_found = 1 AND rank_group IS NOT NULL",
    ),
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
    keywordsRanked,
    keywordsPositioned,
    // HAVE WE LOOKED? Distinct eligible keywords with a real live observation,
    // found or genuinely not-found. A not-found is a measurement — the SERP was
    // read and CheckSig was not in it — so it counts here.
    rankingCoverage: coverageOf(keywordsRanked, keywordsWithVolume),
    // CAN WE WEIGHT IT? Distinct eligible keywords holding an actual position.
    // Strictly the smaller of the two, and the one Share of Search needs.
    positionCoverage: coverageOf(keywordsPositioned, keywordsWithVolume),
    // Share of Search needs half the keywords with a known volume to have a
    // POSITION, which is what the metric itself requires.
    shareOfSearchComputable:
      keywordsWithVolume > 0 &&
      keywordsPositioned / keywordsWithVolume >= MIN_RANKING_COVERAGE,
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
