import { isEnabled, type Phase0Config } from "../phase0-env";
import * as entities from "./store";
import * as store from "./ai-visibility-store";
import * as findings from "./backlink-findings-store";
import { newId, nowIso } from "./ids";
import {
  citationDelta,
  computeMetrics,
  detectAiEvents,
  normalizeDomain,
  type AiVisibilityMetrics,
  type CitationFacts,
  type SnapshotFacts,
} from "./ai-visibility";
import { observeQuery, providerStatusFor } from "./ai-visibility-provider";

/**
 * Morgana Search Intelligence — AI Visibility orchestration.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * One refresh observes a bounded slice of the watchlist, records what it saw,
 * compares it with the previous observation of the same query and raises the
 * few changes that are worth a message. Everything it observes comes from the
 * provider boundary, which currently refuses live collection — so in this
 * deployment the whole path runs on fixtures, visibly labelled.
 */

const AI_ENGINE = "google_ai_overview";
const BATCH_SIZE = 5;

interface RefreshOutcome {
  queryId: string;
  status: "observed" | "refused" | "skipped";
  reason?: string;
  source: "fixture" | "dataforseo";
  eventsRaised: number;
}

interface DomainContext {
  primaryDomains: string[];
  competitorDomains: string[];
  entityByDomain: Map<string, string>;
}

async function domainContext(): Promise<DomainContext> {
  const all = await entities.listEntities();
  const entityByDomain = new Map<string, string>();
  const primaryDomains: string[] = [];
  const competitorDomains: string[] = [];
  for (const entity of all) {
    const domain = normalizeDomain(entity.normalizedDomain);
    entityByDomain.set(domain, entity.id);
    if (entity.entityType === "primary") primaryDomains.push(domain);
    else competitorDomains.push(domain);
  }
  return { primaryDomains, competitorDomains, entityByDomain };
}

/**
 * Domains phases 3–4 already consider suspicious.
 *
 * Routing to brand protection depends on this rather than on anything about the
 * citation itself: a domain is suspicious because the risk model said so, and
 * re-deciding that here would create a second, quieter opinion.
 */
async function suspiciousDomains(): Promise<Set<string>> {
  try {
    const rows = await findings.listFindings({ limit: 200 });
    return new Set(
      rows
        .filter(
          (row) =>
            row.riskClassification === "high_risk" ||
            row.riskClassification === "suspicious" ||
            row.eventType === "possible_impersonation",
        )
        .flatMap((row) =>
          row.subjectDomain ? [normalizeDomain(row.subjectDomain)] : [],
        ),
    );
  } catch {
    // Phase 3 having no findings is not an error for phase 5.
    return new Set<string>();
  }
}

function priorityOf(value: string): "critical" | "high" | "normal" | "low" {
  return value === "critical" || value === "high" || value === "low"
    ? value
    : "normal";
}

/** Which queries are due, most important first. */
function selectDueQueries<
  T extends {
    id: string;
    priority: string;
    lastCheckedAt: string | null;
    checkIntervalHours: number;
  },
>(queries: readonly T[], now: Date = new Date()): T[] {
  const rank = { critical: 0, high: 1, normal: 2, low: 3 } as const;
  return queries
    .filter((query) => {
      if (!query.lastCheckedAt) return true;
      const age = now.getTime() - new Date(query.lastCheckedAt).getTime();
      return age >= query.checkIntervalHours * 3600_000;
    })
    .toSorted(
      (a, b) => rank[priorityOf(a.priority)] - rank[priorityOf(b.priority)],
    );
}

export async function refreshQuery(
  config: Phase0Config,
  env: object,
  queryId: string,
  context?: { domains: DomainContext; suspicious: ReadonlySet<string> },
): Promise<RefreshOutcome> {
  const query = await store.getQuery(queryId);
  if (!query) {
    return {
      queryId,
      status: "skipped",
      reason: "unknown query",
      source: "fixture",
      eventsRaised: 0,
    };
  }
  const domains = context?.domains ?? (await domainContext());
  const suspicious = context?.suspicious ?? (await suspiciousDomains());

  const observation = await observeQuery(config, env, {
    queryId: query.id,
    query: query.query,
    locationCode: query.locationCode,
    languageCode: query.languageCode,
    primaryDomains: domains.primaryDomains,
    competitorDomains: domains.competitorDomains,
    engine: AI_ENGINE,
  });

  const at = nowIso();
  const snapshot = await store.saveSnapshot({
    id: newId("ais"),
    queryId: query.id,
    provider: "dataforseo",
    engine: AI_ENGINE,
    checkedAt: at,
    aiResultPresent: observation.aiResultPresent,
    primaryBrandMentioned: observation.primaryBrandMentioned,
    primaryBrandCited: observation.primaryBrandCited,
    competitorMentions: observation.competitorMentions,
    competitorCitations: observation.competitorCitations,
    citedDomainCount:
      observation.citations.length === 0 && observation.aiResultPresent === null
        ? null
        : observation.citations.length,
    organicPosition: observation.organicPosition,
    source: observation.source,
    providerStatus: observation.providerStatus,
    comparisonStatus: observation.comparisonStatus,
    estimatedCostMicros: 0,
    actualCostMicros: 0,
    dedupeKey: store.snapshotDedupeKey(query.id, AI_ENGINE),
  });

  await store.saveCitations(
    snapshot.id,
    query.id,
    observation.citations.map((citation) => ({
      ...citation,
      entityId: domains.entityByDomain.get(citation.normalizedDomain) ?? null,
    })),
  );
  await store.markQueryChecked(query.id);

  if (observation.refusalReason) {
    return {
      queryId: query.id,
      status: "refused",
      reason: observation.refusalReason,
      source: observation.source,
      eventsRaised: 0,
    };
  }

  // Compare with the previous observation of THIS query. A comparison against a
  // refusal is meaningless, so it is skipped rather than producing "everything
  // changed".
  const previous = await store.previousSnapshot(query.id, snapshot.id);
  let eventsRaised = 0;
  if (previous && previous.comparisonStatus === "complete") {
    const [currentCitations, previousCitations] = await Promise.all([
      store.citationsFor([snapshot.id]),
      store.citationsFor([previous.id]),
    ]);
    const delta = citationDelta(
      toCitationFacts(currentCitations),
      toCitationFacts(previousCitations),
    );
    const events = detectAiEvents({
      queryId: query.id,
      priority: priorityOf(query.priority),
      current: snapshotFacts(snapshot),
      previous: snapshotFacts(previous),
      delta,
      suspiciousDomains: suspicious,
      citationShareChange: null,
    });
    eventsRaised = await store.saveEvents(events);
  }

  return {
    queryId: query.id,
    status: "observed",
    source: observation.source,
    eventsRaised,
  };
}

/** Citation rows reduced to the fields the delta actually compares. */
export function toCitationFacts(
  rows: readonly store.AiCitationRow[],
): CitationFacts[] {
  return rows.map((row) => ({
    queryId: row.queryId,
    normalizedDomain: row.normalizedDomain,
    entityId: row.entityId,
    citationOrder: row.citationOrder,
  }));
}

function snapshotFacts(row: store.AiSnapshotRow): SnapshotFacts {
  return {
    queryId: row.queryId,
    priority: "normal",
    aiResultPresent: row.aiResultPresent,
    primaryBrandMentioned: row.primaryBrandMentioned,
    primaryBrandCited: row.primaryBrandCited,
    competitorMentions: row.competitorMentions,
    competitorCitations: row.competitorCitations,
    citedDomainCount: row.citedDomainCount,
    checkedAt: row.checkedAt,
  };
}

export async function runAiVisibilityTick(
  config: Phase0Config,
  env: object,
  limit = BATCH_SIZE,
): Promise<{
  processed: RefreshOutcome[];
  due: number;
  skipped: string | null;
}> {
  if (!isEnabled(config.SEARCH_INTELLIGENCE_AI_VISIBILITY_ENABLED)) {
    return { processed: [], due: 0, skipped: "ai visibility is disabled" };
  }
  const queries = await store.listQueries();
  const due = selectDueQueries(queries);
  const domains = await domainContext();
  const suspicious = await suspiciousDomains();

  const processed: RefreshOutcome[] = [];
  for (const query of due.slice(0, limit)) {
    processed.push(
      await refreshQuery(config, env, query.id, { domains, suspicious }),
    );
  }
  return { processed, due: due.length, skipped: null };
}

interface AiVisibilityOverview {
  metrics: AiVisibilityMetrics;
  providerStatus: string;
  /** Fixture and live data are never presented as the same thing. */
  source: "fixture" | "dataforseo" | "mixed" | "none";
  queries: {
    id: string;
    query: string;
    cluster: string | null;
    priority: string;
    enabled: boolean;
    lastCheckedAt: string | null;
    aiResultPresent: boolean | null;
    brandMentioned: boolean | null;
    brandCited: boolean | null;
    citedDomainCount: number | null;
    source: string | null;
  }[];
  recentEvents: {
    id: string;
    queryId: string;
    eventType: string;
    severity: string;
    domain: string | null;
    reason: string;
    occurredAt: string;
    deliveryStatus: string;
  }[];
}

export async function aiVisibilityOverview(
  config: Phase0Config,
  env: object,
): Promise<AiVisibilityOverview> {
  const [queries, snapshots] = await Promise.all([
    store.listQueries({ includeDisabled: true }),
    store.currentSnapshots(),
  ]);
  const citations = await store.citationsFor(
    snapshots.map((snapshot) => snapshot.id),
  );
  const enabled = queries.filter((query) => query.enabled);

  const metrics = computeMetrics(
    snapshots.map((snapshot) => ({
      ...snapshotFacts(snapshot),
      priority: priorityOf(
        queries.find((query) => query.id === snapshot.queryId)?.priority ??
          "normal",
      ),
    })),
    citations.map((citation) => ({
      queryId: citation.queryId,
      normalizedDomain: citation.normalizedDomain,
      entityId: citation.entityId,
      citationOrder: citation.citationOrder,
    })),
    enabled.length,
  );

  const sources = new Set(snapshots.map((snapshot) => snapshot.source));
  const source =
    sources.size === 0
      ? ("none" as const)
      : sources.size > 1
        ? ("mixed" as const)
        : ([...sources][0] ?? "none");

  const byQuery = new Map(
    snapshots.map((snapshot) => [snapshot.queryId, snapshot]),
  );
  const events = await store.pendingEvents(25);

  return {
    metrics,
    providerStatus: providerStatusFor(config, env),
    source: source,
    queries: queries.map((query) => {
      const snapshot = byQuery.get(query.id);
      return {
        id: query.id,
        query: query.query,
        cluster: query.cluster,
        priority: query.priority,
        enabled: query.enabled,
        lastCheckedAt: query.lastCheckedAt,
        aiResultPresent: snapshot?.aiResultPresent ?? null,
        brandMentioned: snapshot?.primaryBrandMentioned ?? null,
        brandCited: snapshot?.primaryBrandCited ?? null,
        citedDomainCount: snapshot?.citedDomainCount ?? null,
        source: snapshot?.source ?? null,
      };
    }),
    recentEvents: events.map((event) => ({
      id: event.id,
      queryId: event.queryId,
      eventType: event.eventType,
      severity: event.severity,
      domain: event.domain,
      reason: event.reason,
      occurredAt: event.occurredAt,
      deliveryStatus: event.deliveryStatus,
    })),
  };
}

interface AiCostStatus {
  costCentre: string;
  providerStatus: string;
  liveProviderEnabled: boolean;
  snapshots: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  monthlyCapUsd: number;
  dailyCapUsd: number;
}

export async function aiCostStatus(
  config: Phase0Config,
  env: object,
): Promise<AiCostStatus> {
  const totals = await store.costTotals();
  return {
    // Its own centre, so "what is AI Visibility costing" is answerable without
    // subtracting one ledger from another (the phase-2 mistake).
    costCentre: "dataforseo_search_ai_visibility",
    providerStatus: providerStatusFor(config, env),
    liveProviderEnabled: isEnabled(
      config.SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED,
    ),
    snapshots: totals.snapshots,
    estimatedCostUsd: totals.estimatedCostMicros / 1_000_000,
    actualCostUsd: totals.actualCostMicros / 1_000_000,
    monthlyCapUsd: config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD,
    dailyCapUsd: config.SEO_DATAFORSEO_DAILY_COST_CAP_USD,
  };
}
