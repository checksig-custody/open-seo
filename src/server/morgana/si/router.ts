import { isEnabled, type Phase0Config } from "../phase0-env";
import * as service from "./service";
import { costStatus } from "./cost";
import * as store from "./store";
import * as jobStore from "./job-store";
import {
  projectDeltas,
  projectEntity,
  projectKeyword,
  projectPage,
} from "./projections";
import { dispatchPhase2 } from "./p2-router";
import { dispatchPhase3 } from "./backlink-router";
import { dispatchPhase4 } from "./p4-router";
import { dispatchSiteAudit, dispatchSiteAuditOperations } from "./p5-router";
import {
  dispatchAiVisibility,
  dispatchAiVisibilityOperations,
} from "./p5-ai-router";
import {
  badRequest,
  envelope,
  json,
  readJson,
  bool,
  num,
  str,
  clamp,
} from "./http";

/**
 * Morgana Search Intelligence — request routing.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Split from api.ts so both stay inside the 400-line module limit, and so the
 * entry point (auth posture, logging, error sanitising) reads separately from
 * the route table.
 */

/**
 * One context object instead of six positional parameters. The repo caps
 * parameters at five, and a context is the better shape anyway: every handler
 * below needs the same five things, and adding a sixth later should not ripple
 * through every signature.
 */
export interface SiRequestContext {
  route: string;
  request: Request;
  url: URL;
  config: Phase0Config;
  env: object;
  providerStatus: service.ProviderStatus;
}

/**
 * Read surfaces. Split from the mutating ones so neither function exceeds the
 * repo's complexity ceiling, and so "what can change state" is a single
 * readable list rather than a branch buried in a 60-way conditional.
 */
async function dispatchReads(ctx: SiRequestContext): Promise<Response | null> {
  const { route, request, url, config, providerStatus } = ctx;
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
          site_audit_scheduler: isEnabled(
            config.SEARCH_INTELLIGENCE_SITE_AUDIT_SCHEDULER_ENABLED,
          ),
          ai_visibility: isEnabled(
            config.SEARCH_INTELLIGENCE_AI_VISIBILITY_ENABLED,
          ),
          // Explicitly false rather than absent, so a reader can tell "off"
          // from "this build does not know about it".
          ai_visibility_live_provider: isEnabled(
            config.SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED,
          ),
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

  return null;
}

/** Mutating surfaces: comparison, refresh, the scheduler tick and cost. */
async function dispatchOperations(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, url, config, env, providerStatus } = ctx;
  const method = request.method;
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
      // `force` was accepted by the service and never forwarded, which made the
      // documented recovery path a no-op: after a failed or partial collection
      // the day's snapshot already exists, so every retry returned
      // `snapshot_already_current` without re-collecting. Re-collecting costs
      // money, so it stays explicit — but it has to be reachable.
      force: bool(body.force) ?? false,
    });
    return json(envelope(config, { job: outcome }, { providerStatus }));
  }

  const jobMatch = /^jobs\/([A-Za-z0-9_-]{1,64})$/.exec(route);
  if (jobMatch?.[1] && method === "GET") {
    const job = await jobStore.getJob(jobMatch[1]);
    if (!job) return json({ error: "job not found" }, 404);
    return json(envelope(config, { job }, { providerStatus }));
  }

  if (route === "jobs" && method === "GET") {
    const jobs = await jobStore.recentJobs(
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
    const status = await costStatus(config, env);
    return json(envelope(config, status, { providerStatus }));
  }

  return null;
}

export async function dispatch(ctx: SiRequestContext): Promise<Response> {
  return (
    (await dispatchReads(ctx)) ??
    (await dispatchOperations(ctx)) ??
    (await dispatchPhase2(ctx)) ??
    (await dispatchPhase3(ctx)) ??
    (await dispatchPhase4(ctx)) ??
    (await dispatchSiteAudit(ctx)) ??
    (await dispatchSiteAuditOperations(ctx)) ??
    (await dispatchAiVisibility(ctx)) ??
    (await dispatchAiVisibilityOperations(ctx)) ??
    json({ error: "not found" }, 404)
  );
}
