import { isEnabled, readPhase0Config, type Phase0Config } from "../phase0-env";
import { incrementCounter, log, requestIdFor } from "../phase0-logging";
import { DomainValidationError } from "./domains";
import * as service from "./service";
import * as store from "./store";

/**
 * Morgana Search Intelligence — private API surface.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Reachable only over Morgana's Service Binding: this Worker has no route and
 * `workers_dev: false`, so nothing here is exposed to the internet. Morgana is
 * the sole caller and performs all user authentication and authorisation before
 * it gets here — this layer's job is to be a correct, versioned, non-leaking
 * data surface, not an auth boundary.
 *
 * Every response carries the same envelope so the client can validate one shape
 * and detect a version mismatch rather than mis-parsing a changed payload.
 */

const SI_API_VERSION = "2026-08-06";
const SI_PATH_PREFIX = "/internal/si/";

interface EnvelopeMeta {
  cacheStatus?: "hit" | "miss" | "not_applicable";
  providerStatus?: string;
  costEstimatedUsd?: number;
  costActualUsd?: number;
}

function envelope(
  config: Phase0Config,
  data: unknown,
  meta: EnvelopeMeta = {},
) {
  return {
    api_version: SI_API_VERSION,
    engine_version: config.ENGINE_UPSTREAM_RELEASE,
    upstream_version: config.ENGINE_UPSTREAM_RELEASE,
    upstream_commit: config.ENGINE_UPSTREAM_COMMIT,
    environment: config.SEARCH_INTELLIGENCE_ENVIRONMENT,
    data,
    fetched_at: new Date().toISOString(),
    cache_status: meta.cacheStatus ?? "not_applicable",
    provider_status: meta.providerStatus ?? "unknown",
    cost_estimated_usd: meta.costEstimatedUsd ?? 0,
    cost_actual_usd: meta.costActualUsd ?? 0,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

function badRequest(code: string, message: string): Response {
  return json({ error: message, code }, 400);
}

/** Public projection of an entity. No internal-only field leaves the engine. */
function projectEntity(row: store.SearchEntityRow) {
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

function projectDeltas(deltas: service.DomainOverview["deltas"]) {
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

function projectKeyword(row: unknown) {
  const kw = row as KeywordRecord;
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

function projectPage(row: unknown) {
  const page = row as PageRecord;
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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Route a Search Intelligence request. Returns null for anything outside the
 * `/internal/si/` prefix so the Phase-0 contract routes and upstream dispatch
 * are untouched.
 */
export async function handleSearchIntelligenceRequest(
  request: Request,
  env: object,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(SI_PATH_PREFIX)) return null;

  const requestId = requestIdFor(request);
  const started = Date.now();
  incrementCounter("service_binding_requests");

  let config: Phase0Config;
  try {
    config = readPhase0Config(env);
  } catch {
    incrementCounter("service_binding_failures");
    return json({ error: "invalid engine configuration" }, 500);
  }

  // The whole surface is behind the master flag. With it off the engine behaves
  // as though Search Intelligence does not exist, which is what makes the
  // Morgana-side kill switch total rather than cosmetic.
  if (!isEnabled(config.SEARCH_INTELLIGENCE_ENABLED)) {
    return json(
      { error: "search intelligence is disabled", code: "feature_disabled" },
      404,
    );
  }

  const route = url.pathname.slice(SI_PATH_PREFIX.length);
  const providerStatus = service.resolveProviderStatus(config, env);

  try {
    const response = await dispatch(
      route,
      request,
      url,
      config,
      env,
      providerStatus,
    );
    log("info", config.SEARCH_INTELLIGENCE_ENVIRONMENT, {
      event: "si_request",
      request_id: requestId,
      path: url.pathname,
      status: response.status,
      latency_ms: Date.now() - started,
    });
    return response;
  } catch (error) {
    incrementCounter("service_binding_failures");
    if (error instanceof DomainValidationError) {
      // A validation failure is the caller's, and its message is safe: it was
      // authored here, never derived from provider or driver output.
      return badRequest(error.code, error.message);
    }
    log("error", config.SEARCH_INTELLIGENCE_ENVIRONMENT, {
      event: "si_request_failed",
      request_id: requestId,
      path: url.pathname,
      status: 500,
      latency_ms: Date.now() - started,
      error_code: "HANDLER_FAILED",
    });
    // Never propagate the cause: it can carry a binding name or driver text.
    return json({ error: "internal error" }, 500);
  }
}

async function dispatch(
  route: string,
  request: Request,
  url: URL,
  config: Phase0Config,
  env: object,
  providerStatus: service.ProviderStatus,
): Promise<Response> {
  const method = request.method;

  if (route === "capabilities" && method === "GET") {
    return json(
      envelope(
        config,
        {
          domain_overview: isEnabled(config.SEARCH_INTELLIGENCE_ENABLED),
          competitor_comparison: isEnabled(config.SEARCH_INTELLIGENCE_ENABLED),
          top_keywords: true,
          top_pages: true,
          backlink_overview: true,
          visibility_share: true,
          manual_refresh: true,
          paid_calls: isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED),
          // Explicitly false, not absent, so a Phase-2 reader sees the boundary.
          keyword_gap: false,
          rank_tracking: false,
          backlink_details: false,
          site_audit: isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED),
          mcp: isEnabled(config.SEARCH_INTELLIGENCE_MCP_ENABLED),
          ai: isEnabled(config.SEARCH_INTELLIGENCE_AI_ENABLED),
        },
        { providerStatus },
      ),
    );
  }

  if (route === "entities" && method === "GET") {
    const includeDisabled = url.searchParams.get("includeDisabled") === "true";
    const entities = await store.listEntities({ includeDisabled });
    return json(
      envelope(
        config,
        { entities: entities.map(projectEntity) },
        { providerStatus },
      ),
    );
  }

  if (route === "entities" && method === "POST") {
    const body = await readJson(request);
    const displayName = str(body.display_name);
    const domain = str(body.domain);
    const entityType = str(body.entity_type);
    if (!displayName)
      return badRequest("display_name_required", "display_name is required");
    if (!domain) return badRequest("domain_required", "domain is required");
    if (
      entityType !== "primary" &&
      entityType !== "competitor" &&
      entityType !== "watch"
    ) {
      return badRequest(
        "entity_type_invalid",
        "entity_type must be primary, competitor or watch",
      );
    }
    const priority = str(body.priority);
    const created = await store.createEntity({
      displayName,
      domain,
      entityType,
      priority:
        priority === "high" || priority === "low" || priority === "normal"
          ? priority
          : undefined,
      includeSubdomains: bool(body.include_subdomains),
      locationCode: num(body.location_code),
      languageCode: str(body.language_code),
      refreshIntervalHours: num(body.refresh_interval_hours),
      backlinkIntervalHours: num(body.backlink_interval_hours),
    });
    return json(
      envelope(config, { entity: projectEntity(created) }, { providerStatus }),
      201,
    );
  }

  const entityMatch = /^entities\/([A-Za-z0-9_-]{1,64})$/.exec(route);
  if (entityMatch?.[1] && method === "PATCH") {
    const body = await readJson(request);
    const priority = str(body.priority);
    const updated = await store.updateEntity(entityMatch[1], {
      displayName: str(body.display_name),
      priority:
        priority === "high" || priority === "low" || priority === "normal"
          ? priority
          : undefined,
      includeSubdomains: bool(body.include_subdomains),
      locationCode: num(body.location_code),
      languageCode: str(body.language_code),
      refreshIntervalHours: num(body.refresh_interval_hours),
      backlinkIntervalHours: num(body.backlink_interval_hours),
      enabled: bool(body.enabled),
    });
    if (!updated) return json({ error: "entity not found" }, 404);
    return json(
      envelope(config, { entity: projectEntity(updated) }, { providerStatus }),
    );
  }

  const overviewMatch = /^overview\/([A-Za-z0-9_-]{1,64})$/.exec(route);
  if (overviewMatch?.[1] && method === "GET") {
    const overview = await service.domainOverview(overviewMatch[1], {
      keywordLimit: clamp(url.searchParams.get("keywordLimit"), 20, 100),
      pageLimit: clamp(url.searchParams.get("pageLimit"), 20, 100),
    });
    if (!overview) return json({ error: "entity not found" }, 404);
    return json(
      envelope(
        config,
        {
          entity: projectEntity(overview.entity),
          snapshot: overview.snapshot,
          deltas: projectDeltas(overview.deltas),
          top_keywords: overview.topKeywords.map(projectKeyword),
          top_pages: overview.topPages.map(projectPage),
          freshness: overview.freshness,
        },
        { providerStatus },
      ),
    );
  }

  const historyMatch = /^history\/([A-Za-z0-9_-]{1,64})$/.exec(route);
  if (historyMatch?.[1] && method === "GET") {
    const days = clamp(url.searchParams.get("days"), 30, 365) ?? 30;
    const since = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const history = await store.snapshotHistory(historyMatch[1], since);
    return json(
      envelope(
        config,
        {
          entity_id: historyMatch[1],
          days,
          points: history.map((p) => ({
            snapshot_date: p.snapshotDate,
            organic_traffic_estimate: p.organicTrafficEstimate,
            organic_keyword_count: p.organicKeywordCount,
            backlink_count: p.backlinkCount,
            referring_domain_count: p.referringDomainCount,
          })),
        },
        { providerStatus },
      ),
    );
  }

  const keywordsMatch = /^keywords\/([A-Za-z0-9_-]{1,64})$/.exec(route);
  if (keywordsMatch?.[1] && method === "GET") {
    const snapshot = await store.latestSnapshot(keywordsMatch[1]);
    if (!snapshot) {
      return json(
        envelope(config, { keywords: [], snapshot: null }, { providerStatus }),
      );
    }
    const rows = await store.snapshotKeywords(
      snapshot.id,
      clamp(url.searchParams.get("limit"), 100, 100) ?? 100,
    );
    return json(
      envelope(
        config,
        {
          snapshot: { id: snapshot.id, snapshot_date: snapshot.snapshotDate },
          keywords: rows.map(projectKeyword),
        },
        { providerStatus },
      ),
    );
  }

  const pagesMatch = /^pages\/([A-Za-z0-9_-]{1,64})$/.exec(route);
  if (pagesMatch?.[1] && method === "GET") {
    const snapshot = await store.latestSnapshot(pagesMatch[1]);
    if (!snapshot) {
      return json(
        envelope(config, { pages: [], snapshot: null }, { providerStatus }),
      );
    }
    const rows = await store.snapshotPages(
      snapshot.id,
      clamp(url.searchParams.get("limit"), 100, 100) ?? 100,
    );
    return json(
      envelope(
        config,
        {
          snapshot: { id: snapshot.id, snapshot_date: snapshot.snapshotDate },
          pages: rows.map(projectPage),
        },
        { providerStatus },
      ),
    );
  }

  if (route === "compare" && method === "POST") {
    const body = await readJson(request);
    const ids = Array.isArray(body.entity_ids)
      ? body.entity_ids
          .filter((v): v is string => typeof v === "string")
          .slice(0, 20)
      : [];
    if (ids.length < 1) {
      return badRequest(
        "entity_ids_required",
        "entity_ids must contain at least one id",
      );
    }
    const result = await service.compareDomains(ids);
    return json(
      envelope(
        config,
        {
          rows: result.rows.map((row) => ({
            entity: projectEntity(row.entity),
            snapshot_date: row.snapshotDate,
            organic_traffic_estimate: row.organicTrafficEstimate,
            organic_keyword_count: row.organicKeywordCount,
            backlink_count: row.backlinkCount,
            referring_domain_count: row.referringDomainCount,
            deltas: projectDeltas(row.deltas),
            visibility_share: row.visibilityShare,
            visibility_share_status: row.visibilityShareStatus,
            top_keyword: row.topKeyword,
            top_page: row.topPage,
            freshness: row.freshness,
          })),
          visibility_share_status: result.visibility.status,
          visibility_share_reason: result.visibility.reason ?? null,
        },
        { providerStatus },
      ),
    );
  }

  if (route === "refresh" && method === "POST") {
    const body = await readJson(request);
    const entityId = str(body.entity_id);
    if (!entityId)
      return badRequest("entity_id_required", "entity_id is required");
    const trigger = str(body.trigger) === "scheduled" ? "scheduled" : "manual";
    const outcome = await service.refreshEntity(config, env, {
      entityId,
      trigger,
      requestedBy: str(body.requested_by) ?? null,
    });
    return json(envelope(config, { job: outcome }, { providerStatus }));
  }

  const jobMatch = /^jobs\/([A-Za-z0-9_-]{1,64})$/.exec(route);
  if (jobMatch?.[1] && method === "GET") {
    const job = await store.getJob(jobMatch[1]);
    if (!job) return json({ error: "job not found" }, 404);
    return json(envelope(config, { job }, { providerStatus }));
  }

  if (route === "jobs" && method === "GET") {
    const jobs = await store.recentJobs(
      clamp(url.searchParams.get("limit"), 50, 200) ?? 50,
    );
    return json(envelope(config, { jobs }, { providerStatus }));
  }

  /**
   * Scheduler tick. Morgana's cron calls this; the engine has no cron of its
   * own, which is what guarantees it cannot spend unless asked.
   */
  if (route === "tick" && method === "POST") {
    const entities = await store.listEntities();
    const due = service.selectDueEntities(entities);
    const outcomes: service.RefreshOutcome[] = [];
    // Bounded per tick so one invocation cannot exhaust the subrequest budget
    // or the daily cap in a single burst.
    for (const entity of due.slice(0, 3)) {
      outcomes.push(
        await service.refreshEntity(config, env, {
          entityId: entity.id,
          trigger: "scheduled",
        }),
      );
    }
    return json(
      envelope(
        config,
        { due: due.length, processed: outcomes.length, outcomes },
        { providerStatus },
      ),
    );
  }

  if (route === "cost" && method === "GET") {
    const status = await service.costStatus(config, env);
    return json(envelope(config, status, { providerStatus }));
  }

  return json({ error: "not found" }, 404);
}

function clamp(
  raw: string | null,
  fallback: number,
  max: number,
): number | undefined {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
