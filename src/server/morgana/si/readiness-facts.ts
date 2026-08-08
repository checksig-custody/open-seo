import { sql } from "drizzle-orm";
import { db } from "@/db";
import { type Phase0Config } from "../phase0-env";
import { readProviderState } from "./provider-circuit";
import { type ReadinessFacts } from "./rollout-readiness";

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

/**
 * Did Share of Search actually produce a number, the last time it was asked?
 *
 * READ FROM THE METRIC, NOT RE-DERIVED. A readiness report that recomputes a
 * metric's own precondition will disagree with it eventually, and did: on
 * 2026-08-07 a proxy over ALL of history counted three positioned keywords of
 * six and called the metric computable, while the metric — which weights a
 * SINGLE day — had two of six that day and refused. Both arithmetics were
 * right; only one of them was Share of Search.
 *
 * So this asks the persisted snapshot what happened. `null` when the metric has
 * never run, which is a third answer and not a false.
 */
async function shareOfSearchStatus(): Promise<string | null> {
  try {
    const rows = await db.all<{ status: string }>(
      sql.raw(
        `SELECT status FROM share_of_search_snapshots
         WHERE cluster_id IS NULL
         ORDER BY calculated_at DESC LIMIT 1`,
      ),
    );
    return rows[0]?.status ?? null;
  } catch {
    return null;
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
    providerState,
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
    // A CRAWL THAT FINISHED AND READ SOMETHING — not merely a row.
    //
    // This was `1 = 1`, the only fact in this file without a provenance filter,
    // in a file whose own comment says a row that came from a provider counts
    // and a fixture does not. So a `queued` run that never advanced, a
    // half-crawled `running` one, and a `failed` one all satisfied the Site
    // Audit gate: a bare request with no crawl behind it read as verification.
    countRows(
      "si_site_audit_runs",
      "source = 'first_party_crawl' AND status = 'completed' AND pages_crawled > 0",
    ),
    countRows("si_backlink_snapshots", "source = 'dataforseo'"),
    countRows(
      "si_backlink_snapshots",
      "source = 'dataforseo' AND entity_id <> (SELECT id FROM search_entities WHERE entity_type = 'primary' LIMIT 1)",
    ),
    countRows("si_ai_observations", "source = 'dataforseo'"),
    // The provider's own verdict on the account. Null means never observed,
    // which the matrix keeps distinct from healthy.
    readProviderState(),
  ]);

  const shareStatus = await shareOfSearchStatus();

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
    // The metric's own verdict, not a second opinion about it.
    shareOfSearchComputable: shareStatus === "ok",
    measuredCostMicros: {
      domain_overview: costOf("domain_overview"),
      // Both of these read `phase2` until 2026-08-08 — a collector whose ledger
      // holds job counters and no money, so it was permanently 0, so both
      // reported a null cost. Ranking had in fact been paid for six times.
      ranking: costOf("ranking"),
      keyword_volume: costOf("keyword_volume"),
      backlinks: costOf("backlinks"),
    },
    overDailyCap: spend.overDailyCap,
    reconciliationPending: spend.reconciliationPending,
    unexpectedSpendDetected: spend.unexpectedSpendDetected,
    // Read from the parsed config's own diagnostic rather than from the raw
    // values, so no webhook string can reach this object.
    webhooksInvalid: invalidWebhookChannels(config),
    // Stated, not implied: the engine holds no webhook and did not look.
    webhooksEvaluated: false,
    providerCircuitState: providerState?.state ?? null,
  };
}

/**
 * Which alert channels hold an unusable webhook — a question this engine cannot
 * answer, and now says so.
 *
 * WHAT WAS WRONG. This returned all three channels as invalid whenever the
 * environment was `production`, on the reasoning that alerts were off anyway.
 * That is not a reading of anything; it is a constant wearing the shape of a
 * fact, and it became a false one the moment the three webhook secrets were
 * provisioned in Morgana on 2026-08-08 — the blocker would have stayed shut
 * forever while the configuration behind it was correct.
 *
 * THE ENGINE HAS NO WEBHOOKS. They live in Morgana's config, and Morgana
 * classifies them in `src/config/webhook-diagnostics.ts` from the RAW
 * environment, which is the only place the distinction between "absent" and
 * "present but malformed" still exists. So the honest answer here is the empty
 * list plus an explicit `webhooksEvaluated: false` on the facts, and the
 * composite release gate is evaluated by the verifier in Morgana, which can see
 * both halves.
 *
 * A GATE THAT CANNOT SEE A THING MUST NOT REPORT ON IT — in either direction.
 * `evaluateReleaseGate` therefore emits `webhooks_not_evaluated` rather than
 * silently dropping the row, so an engine-only reader cannot mistake this for
 * a clean bill of health.
 */
function invalidWebhookChannels(_config: Phase0Config): string[] {
  return [];
}
