import type * as store from "./store";
import type * as service from "./service";

/**
 * Morgana Search Intelligence — wire projections.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * The only place an internal row becomes a public payload. Split out of api.ts
 * to keep both files inside the 400-line module limit, and because "what we
 * expose" is a different concern from "how we route".
 */

/** Public projection of an entity. No internal-only field leaves the engine. */
export function projectEntity(row: store.SearchEntityRow) {
  return {
    id: row.id,
    display_name: row.displayName,
    canonical_domain: row.canonicalDomain,
    normalized_domain: row.normalizedDomain,
    entity_type: row.entityType,
    enabled: row.enabled,
    priority: row.priority,
    include_subdomains: row.includeSubdomains,
    location_code: row.locationCode,
    language_code: row.languageCode,
    refresh_interval_hours: row.refreshIntervalHours,
    backlink_interval_hours: row.backlinkIntervalHours,
    last_refreshed_at: row.lastRefreshedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    disabled_at: row.disabledAt,
  };
}

function projectDelta(delta: {
  status: string;
  absolute: number | null;
  relative: number | null;
}) {
  return {
    status: delta.status,
    absolute: delta.absolute,
    relative: delta.relative,
  };
}

export function projectDeltas(deltas: service.DomainOverview["deltas"]) {
  if (!deltas) return null;
  return {
    traffic_1d: projectDelta(deltas.trafficDelta1d),
    traffic_7d: projectDelta(deltas.trafficDelta7d),
    traffic_30d: projectDelta(deltas.trafficDelta30d),
    keywords_1d: projectDelta(deltas.keywordCountDelta1d),
    keywords_7d: projectDelta(deltas.keywordCountDelta7d),
    keywords_30d: projectDelta(deltas.keywordCountDelta30d),
    backlinks_7d: projectDelta(deltas.backlinkDelta7d),
    referring_domains_7d: projectDelta(deltas.referringDomainDelta7d),
  };
}

interface KeywordRecord {
  keyword: string;
  rankGroup: number | null;
  rankAbsolute: number | null;
  searchVolume: number | null;
  estimatedTraffic: number | null;
  cpc: number | null;
  keywordDifficulty: number | null;
  searchIntent: string | null;
  rankingUrl: string | null;
  serpUpdatedAt: string | null;
  position: number;
}

export function projectKeyword(kw: KeywordRecord) {
  return {
    keyword: kw.keyword,
    // The user-facing organic position is rank_group; rank_absolute counts ads
    // and SERP features and is exposed separately, never conflated.
    organic_position: kw.rankGroup,
    rank_group: kw.rankGroup,
    rank_absolute: kw.rankAbsolute,
    search_volume: kw.searchVolume,
    estimated_traffic: kw.estimatedTraffic,
    cpc: kw.cpc,
    keyword_difficulty: kw.keywordDifficulty,
    search_intent: kw.searchIntent,
    ranking_url: kw.rankingUrl,
    serp_updated_at: kw.serpUpdatedAt,
    position: kw.position,
  };
}

interface PageRecord {
  url: string;
  normalizedUrl: string;
  estimatedTraffic: number | null;
  keywordCount: number | null;
  topKeyword: string | null;
  topKeywordPosition: number | null;
  pageTitle: string | null;
  lastSeenAt: string | null;
  position: number;
}

export function projectPage(page: PageRecord) {
  return {
    url: page.url,
    normalized_url: page.normalizedUrl,
    estimated_traffic: page.estimatedTraffic,
    keyword_count: page.keywordCount,
    top_keyword: page.topKeyword,
    top_keyword_position: page.topKeywordPosition,
    page_title: page.pageTitle,
    last_seen_at: page.lastSeenAt,
    position: page.position,
  };
}
