import { isEnabled, type Phase0Config } from "../phase0-env";

/**
 * Morgana Search Intelligence — what is actually ready, and what only looks it.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P16).
 *
 * A single `enabled` boolean cannot answer the question this subsystem keeps
 * being asked. "Is Ranking ready" has at least four independent answers: the
 * code exists, a provider has actually served us once, there is enough data to
 * compute anything useful, and somebody has decided to switch it on. Those come
 * apart constantly here — Share of Search is implemented, live-verified in its
 * inputs, and still cannot produce a number because five of six keywords have
 * never been ranked — so they are four fields, not one flag.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: implementation is never reported as
 * verification. Every capability that has not had a real provider round trip
 * says `live_verification_pending`, however complete its code is.
 */

type CapabilityState =
  | "not_implemented"
  | "implemented"
  | "live_verification_pending"
  | "live_verified"
  | "insufficient_data"
  | "unsupported"
  | "account_not_enabled"
  | "blocked_by_budget"
  | "blocked_by_configuration"
  | "degraded"
  | "ready_for_activation";

interface CapabilityReadiness {
  id: string;
  displayName: string;
  /** Does the code exist and pass its own tests? */
  implementation: "not_implemented" | "implemented";
  /** Has a real provider round trip ever succeeded in production? */
  liveVerification: CapabilityState;
  /** Is there enough stored data for the feature to say anything? */
  dataAvailability:
    | "none"
    | "partial"
    | "sufficient"
    | "insufficient_for_metric";
  /** The single state a reader should act on. */
  state: CapabilityState;
  /** Typed, ordered: the first one is what to fix. */
  blockers: string[];
  /** What may legitimately happen next. */
  nextAllowedAction: string;
  /** Measured, in integer micro-USD. Null when nobody has measured it. */
  lastProviderCostMicros: number | null;
  schedulerEnabled: boolean;
  alertsEnabled: boolean;
  uiEnabled: boolean;
}

/** Everything the matrix needs, read from persisted state by the caller. */
export interface ReadinessFacts {
  domainOverviewSnapshots: number;
  rankObservations: number;
  keywordsWithVolume: number;
  keywordsTracked: number;
  siteAuditRuns: number;
  backlinkSnapshotsLive: number;
  backlinkCompetitorSnapshots: number;
  aiObservationsLive: number;
  /** Distinct eligible keywords with a live observation, found or not-found. */
  keywordsRanked: number;
  /** Distinct eligible keywords holding an actual position. */
  keywordsPositioned: number;
  /** `keywordsRanked / keywordsWithVolume`; null when nothing is eligible. */
  rankingCoverage: number | null;
  /** `keywordsPositioned / keywordsWithVolume`; null when nothing is eligible. */
  positionCoverage: number | null;
  shareOfSearchComputable: boolean;
  /** Measured provider costs, per collector, in micro-USD. Null = unmeasured. */
  measuredCostMicros: Record<string, number | null>;
  overDailyCap: boolean;
  reconciliationPending: number;
  unexpectedSpendDetected: boolean;
  webhooksInvalid: string[];
}

const BLOCKER = {
  noLiveRun: "no_live_provider_run",
  budgetDay: "blocked_by_budget_day",
  /** Too few of the eligible keywords have been LOOKED AT. */
  coverage: "insufficient_ranking_coverage",
  /**
   * Enough keywords were measured; too few of them rank.
   *
   * A distinct blocker, and the distinction is the point. "We have not
   * collected enough" is fixed by spending money. "We collected them and
   * CheckSig is not in the results" is fixed by ranking better, and no
   * amount of provider spend will move it. Reporting the second as the first
   * would send someone to buy data that already exists.
   */
  positions: "insufficient_ranked_positions",
  costUnknown: "provider_cost_unknown",
  entitlement: "provider_entitlement_unverified",
  webhooks: "webhooks_invalid",
  reconcile: "reconciliation_pending",
  unexpected: "unexpected_spend_detected",
} as const;

/**
 * The threshold the readiness report holds ranking coverage to.
 *
 * Deliberately the same 0.5 `computeShareOfSearch` enforces on its own inputs.
 * It is stated here as a named constant rather than inlined so that reading
 * this file answers "how much is enough" without going and finding out.
 */
export const MIN_RANKING_COVERAGE = 0.5;

/** Has enough of the eligible watchlist actually been looked at? */
function hasRankingCoverage(facts: ReadinessFacts): boolean {
  return (
    facts.rankingCoverage !== null &&
    facts.rankingCoverage >= MIN_RANKING_COVERAGE
  );
}

function rankingBlockers(facts: ReadinessFacts): string[] {
  if (facts.rankObservations === 0) return [BLOCKER.noLiveRun];
  return hasRankingCoverage(facts) ? [] : [BLOCKER.coverage];
}

function rankingDataAvailability(
  facts: ReadinessFacts,
): CapabilityReadiness["dataAvailability"] {
  if (facts.rankObservations === 0) return "none";
  return hasRankingCoverage(facts) ? "sufficient" : "partial";
}

/**
 * The capability matrix.
 *
 * Every row is derived from facts the caller read out of the database. Nothing
 * here consults a flag to decide whether something *works* — flags decide
 * whether it is switched on, which is a different column.
 */
export function capabilityMatrix(
  config: Phase0Config,
  facts: ReadinessFacts,
): CapabilityReadiness[] {
  // The engine holds the SCHEDULER and ALERT switches it owns; Morgana holds
  // the per-capability rank flags. Reading the ones that exist here — rather
  // than inventing names — is what keeps this matrix a report instead of a
  // wish.
  const schedulerEnabled = isEnabled(
    config.SEARCH_INTELLIGENCE_SITE_AUDIT_SCHEDULER_ENABLED,
  );
  const alertsEnabled =
    isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_ALERTS_ENABLED) ||
    isEnabled(config.SEARCH_INTELLIGENCE_AI_VISIBILITY_ALERTS_ENABLED);
  const uiEnabled = isEnabled(config.SEARCH_INTELLIGENCE_UI_ENABLED);

  const base = {
    schedulerEnabled,
    alertsEnabled,
    uiEnabled,
  };

  const verified = (
    id: string,
    displayName: string,
    hasData: boolean,
    cost: number | null,
    extra: Partial<CapabilityReadiness> = {},
  ): CapabilityReadiness => ({
    id,
    displayName,
    implementation: "implemented",
    liveVerification: hasData ? "live_verified" : "live_verification_pending",
    dataAvailability: hasData ? "sufficient" : "none",
    // Verified with data and switched off is `ready_for_activation` — the only
    // remaining step is a human decision, which is worth saying out loud.
    state: hasData ? "ready_for_activation" : "live_verification_pending",
    blockers: hasData ? [] : [BLOCKER.noLiveRun],
    nextAllowedAction: hasData
      ? "activation decision"
      : "one authorised live collection",
    lastProviderCostMicros: cost,
    ...base,
    ...extra,
  });

  return [
    verified(
      "domain_overview",
      "Domain Overview",
      facts.domainOverviewSnapshots > 0,
      facts.measuredCostMicros.domain_overview ?? null,
    ),
    verified(
      "ranking",
      "Rank Tracking",
      facts.rankObservations > 0,
      facts.measuredCostMicros.ranking ?? null,
      {
        // THIS ROW USED TO CARRY THE BLOCKER UNCONDITIONALLY — `[coverage]`
        // whenever a single observation existed, with no comparison against
        // anything. Since `ranking` is not waivable, the gate could never open
        // again once the first rank landed, however many keywords were later
        // collected. It now asks the coverage what it says.
        //
        // A verified collector with a thin dataset is `partial`: both facts are
        // true, and reporting only the first would oversell it.
        dataAvailability: rankingDataAvailability(facts),
        blockers: rankingBlockers(facts),
        nextAllowedAction: hasRankingCoverage(facts)
          ? "activation decision"
          : "widen ranking coverage before activation is meaningful",
      },
    ),
    verified(
      "keyword_volume",
      "Keyword Volume",
      facts.keywordsWithVolume > 0,
      facts.measuredCostMicros.keyword_volume ?? null,
    ),
    {
      id: "share_of_search",
      displayName: "Tracked Keyword Share of Search",
      implementation: "implemented",
      liveVerification: "live_verified",
      dataAvailability: facts.shareOfSearchComputable
        ? "sufficient"
        : "insufficient_for_metric",
      // The distinction that matters: the code works, the inputs are live, and
      // the metric still refuses — because too few keywords hold a position,
      // not because anything is broken.
      state: facts.shareOfSearchComputable
        ? "ready_for_activation"
        : "insufficient_data",
      // WHICH SHORTAGE, precisely. If the watchlist has not been measured, that
      // is a collection gap and more spend fixes it. If it has been measured
      // and CheckSig does not rank, spending again changes nothing — so the
      // metric says the second thing rather than borrowing the first.
      blockers: facts.shareOfSearchComputable
        ? []
        : hasRankingCoverage(facts)
          ? [BLOCKER.positions]
          : [BLOCKER.coverage],
      nextAllowedAction: hasRankingCoverage(facts)
        ? "improve rankings; the eligible keywords have been measured"
        : "collect rankings for more keywords with known volume",
      lastProviderCostMicros: null,
      ...base,
    },
    verified(
      "site_audit",
      "Site Audit",
      facts.siteAuditRuns > 0,
      // First-party crawling: no provider spends anything, and a zero here
      // would read as "measured at zero" rather than "not applicable".
      null,
    ),
    verified(
      "backlinks_core",
      "Backlink Intelligence",
      facts.backlinkSnapshotsLive > 0,
      facts.measuredCostMicros.backlinks ?? null,
    ),
    {
      id: "backlink_competitor_gap",
      displayName: "Sampled Competitor Backlink Gap",
      implementation: "implemented",
      liveVerification: "live_verification_pending",
      dataAvailability:
        facts.backlinkCompetitorSnapshots > 0 ? "partial" : "none",
      state: facts.overDailyCap
        ? "blocked_by_budget"
        : "live_verification_pending",
      blockers: facts.overDailyCap ? [BLOCKER.budgetDay] : [BLOCKER.noLiveRun],
      nextAllowedAction: "one competitor collection on a budget day with room",
      lastProviderCostMicros: facts.measuredCostMicros.backlinks ?? null,
      ...base,
    },
    {
      id: "ai_visibility",
      displayName: "AI Visibility",
      implementation: "implemented",
      liveVerification: "live_verification_pending",
      dataAvailability: facts.aiObservationsLive > 0 ? "partial" : "none",
      state: "live_verification_pending",
      // Two independent unknowns, and neither is "not built": the account's
      // entitlement and the price. Either alone blocks activation.
      blockers: [BLOCKER.entitlement, BLOCKER.costUnknown],
      nextAllowedAction:
        "one authorised call to settle entitlement and establish the cost",
      lastProviderCostMicros: null,
      ...base,
    },
  ];
}

type ReleaseGateResult = "READY" | "READY_WITH_WAIVERS" | "NOT_READY";

interface Waiver {
  capability: string;
  reason: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string | null;
  impact: string;
}

/** Only these may ever be waived; anything else is a real blocker. */
const WAIVABLE = new Set([
  "ai_visibility",
  "backlink_competitor_gap",
  "webhooks_invalid",
]);

interface ReleaseGate {
  result: ReleaseGateResult;
  blockers: { capability: string; blocker: string; waived: boolean }[];
  summary: string;
}

/**
 * Is the subsystem releasable?
 *
 * Deterministic, and deliberately hard to satisfy: a capability counts only
 * when a provider has actually served it. Waivers exist for the two cases where
 * waiting is a business decision rather than an engineering one — an unproven
 * AI entitlement and a deferred competitor collection — plus invalid webhooks
 * while alerts are off. Nothing else can be waived, and no waiver is ever
 * created automatically.
 */
export function evaluateReleaseGate(
  matrix: readonly CapabilityReadiness[],
  facts: ReadinessFacts,
  waivers: readonly Waiver[] = [],
): ReleaseGate {
  const waivedCapabilities = new Set(
    waivers
      .filter((waiver) => WAIVABLE.has(waiver.capability))
      .map((waiver) => waiver.capability),
  );

  const blockers = matrix.flatMap((capability) =>
    capability.blockers.map((blocker) => ({
      capability: capability.id,
      blocker,
      waived: waivedCapabilities.has(capability.id),
    })),
  );

  if (facts.reconciliationPending > 0) {
    blockers.push({
      capability: "budget_authority",
      blocker: BLOCKER.reconcile,
      waived: false,
    });
  }
  if (facts.unexpectedSpendDetected) {
    blockers.push({
      capability: "budget_authority",
      blocker: BLOCKER.unexpected,
      waived: false,
    });
  }
  if (facts.webhooksInvalid.length > 0) {
    // Waivable only because alerts are off: an invalid webhook that nothing
    // tries to use is a configuration debt, not an incident.
    blockers.push({
      capability: "alerting",
      blocker: BLOCKER.webhooks,
      waived: waivedCapabilities.has("webhooks_invalid"),
    });
  }

  const unwaived = blockers.filter((blocker) => !blocker.waived);
  const result: ReleaseGateResult =
    unwaived.length > 0
      ? "NOT_READY"
      : blockers.length > 0
        ? "READY_WITH_WAIVERS"
        : "READY";

  return {
    result,
    blockers,
    summary:
      unwaived.length > 0
        ? `${String(unwaived.length)} unwaived blocker(s); first: ${unwaived[0].capability}/${unwaived[0].blocker}`
        : blockers.length > 0
          ? `all ${String(blockers.length)} blocker(s) waived`
          : "no blockers",
  };
}
