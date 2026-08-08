import {
  badRequest,
  envelope,
  isRecord,
  json,
  num,
  readJson,
  str,
} from "./http";
import * as p2 from "./p2-store";
import * as p2an from "./p2-analytics-store";
import * as p2jobs from "./p2-jobs-store";
import * as rankTasks from "./rank-task-store";
import { bootstrapTrackedKeywords } from "./rank-bootstrap";
import * as p2service from "./p2-service";
import * as rankRecovery from "./rank-recovery-service";
import { dispatchKeywordVolume } from "./p2-volume-router";
import type { SiRequestContext } from "./router";
import { DEFAULT_CLUSTERS, type Priority } from "./keywords";

/**
 * Morgana Search Intelligence — phase 2 routes.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Mounted under the same private `/internal/si/` prefix, kept in its own module
 * so neither router exceeds the repo's complexity and size limits.
 */

const asPriority = (value: unknown): Priority | undefined =>
  value === "critical" ||
  value === "high" ||
  value === "normal" ||
  value === "low"
    ? value
    : undefined;

const today = () => new Date().toISOString().slice(0, 10);

/** Cluster and keyword configuration — the mutating admin surface. */
async function dispatchConfig(ctx: SiRequestContext): Promise<Response | null> {
  const { route, request, url, config, providerStatus } = ctx;
  const method = request.method;

  // --- clusters ------------------------------------------------------------
  if (route === "clusters" && method === "GET") {
    // Seeding on read keeps the default taxonomy available without a bootstrap
    // step, and is a no-op once the rows exist.
    await p2.ensureDefaultClusters();
    const clusters = await p2.listClusters();
    return json(envelope(config, { clusters }, { providerStatus }));
  }

  if (route === "clusters" && method === "POST") {
    const body = await readJson(request);
    const name = str(body.name);
    const slug = str(body.slug);
    if (!name || !slug)
      return badRequest("name_slug_required", "name and slug are required");
    const cluster = await p2.createCluster({
      name,
      slug,
      weight: num(body.weight),
      description: str(body.description) ?? null,
    });
    return json(envelope(config, { cluster }, { providerStatus }), 201);
  }

  {
    const match = /^clusters\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "PATCH") {
      const body = await readJson(request);
      const cluster = await p2.updateCluster(match[1], {
        name: str(body.name),
        weight: num(body.weight),
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      });
      if (!cluster) return json({ error: "cluster not found" }, 404);
      return json(envelope(config, { cluster }, { providerStatus }));
    }
  }

  // --- tracked keywords ----------------------------------------------------
  if (route === "keywords" && method === "GET") {
    const keywords = await p2.listTrackedKeywords({
      includeDisabled: url.searchParams.get("includeDisabled") === "true",
    });
    return json(envelope(config, { keywords }, { providerStatus }));
  }

  if (route === "keywords" && method === "POST") {
    const body = await readJson(request);
    const keyword = str(body.keyword);
    if (!keyword) return badRequest("keyword_required", "keyword is required");
    await p2.ensureDefaultClusters();
    const clusters = await p2.listClusters();
    const created = await p2.createTrackedKeyword(
      {
        keyword,
        priority: asPriority(body.priority),
        clusterId: str(body.cluster_id) ?? null,
        locationCode: num(body.location_code),
        languageCode: str(body.language_code),
        alertingEnabled:
          typeof body.alerting_enabled === "boolean"
            ? body.alerting_enabled
            : undefined,
      },
      clusters,
    );
    if (!created) {
      return json({ error: "keyword already tracked", code: "duplicate" }, 409);
    }
    return json(
      envelope(config, { keyword: created }, { providerStatus }),
      201,
    );
  }

  if (route === "keywords/import" && method === "POST") {
    const body = await readJson(request);
    const raw: unknown[] = Array.isArray(body.keywords) ? body.keywords : [];
    if (raw.length === 0) {
      return badRequest(
        "keywords_required",
        "keywords must be a non-empty array",
      );
    }
    // Bounded so one import cannot create an unbounded amount of future spend.
    if (raw.length > 500) {
      return badRequest("too_many", "at most 500 keywords per import");
    }
    await p2.ensureDefaultClusters();
    const inputs = raw.flatMap((entry) => {
      if (typeof entry === "string") return [{ keyword: entry }];
      if (isRecord(entry)) {
        const keyword = str(entry.keyword);
        return keyword
          ? [{ keyword, priority: asPriority(entry.priority) }]
          : [];
      }
      return [];
    });
    const result = await p2.bulkImportKeywords(inputs);
    return json(envelope(config, result, { providerStatus }));
  }

  {
    const match = /^keywords\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "PATCH") {
      const body = await readJson(request);
      const updated = await p2.updateTrackedKeyword(match[1], {
        priority: asPriority(body.priority),
        clusterId:
          body.cluster_id === null ? null : (str(body.cluster_id) ?? undefined),
        trackingEnabled:
          typeof body.tracking_enabled === "boolean"
            ? body.tracking_enabled
            : undefined,
        alertingEnabled:
          typeof body.alerting_enabled === "boolean"
            ? body.alerting_enabled
            : undefined,
        searchVolume: num(body.search_volume),
      });
      if (!updated) return json({ error: "keyword not found" }, 404);
      return json(envelope(config, { keyword: updated }, { providerStatus }));
    }
  }

  return null;
}

/** Read surfaces: gap, rank tracking, share of search, events, cost. */
async function dispatchP2Reads(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, url, config, env, providerStatus } = ctx;
  const method = request.method;
  // --- reads ---------------------------------------------------------------
  if (route === "keyword-gap" && method === "GET") {
    const date = str(url.searchParams.get("date")) ?? today();
    const [gaps, keywords, clusters] = await Promise.all([
      p2an.latestGapSnapshots(date),
      p2.listTrackedKeywords({ includeDisabled: true }),
      p2.listClusters(),
    ]);
    const byId = new Map(keywords.map((k) => [k.id, k]));
    const clusterById = new Map(clusters.map((c) => [c.id, c]));
    return json(
      envelope(
        config,
        {
          snapshot_date: date,
          rows: gaps.map((g) => {
            const keyword = byId.get(g.trackedKeywordId);
            return {
              tracked_keyword_id: g.trackedKeywordId,
              keyword: keyword?.keyword ?? null,
              cluster: keyword?.clusterId
                ? (clusterById.get(keyword.clusterId)?.name ?? null)
                : null,
              priority: keyword?.priority ?? null,
              search_volume: keyword?.searchVolume ?? null,
              category: g.category,
              primary_rank: g.primaryRank,
              best_competitor_rank: g.bestCompetitorRank,
              best_competitor_entity_id: g.bestCompetitorEntityId,
              opportunity_score: g.opportunityScore,
            };
          }),
        },
        { providerStatus },
      ),
    );
  }

  if (route === "rank-tracking" && method === "GET") {
    const [keywords, clusters] = await Promise.all([
      p2.listTrackedKeywords({ includeDisabled: true }),
      p2.listClusters(),
    ]);
    const clusterById = new Map(clusters.map((c) => [c.id, c]));
    const date = today();
    const rows = await Promise.all(
      keywords.map(async (k) => {
        const dates = await p2.recentSnapshotDates(k.id, 2);
        const current = await p2.observationsFor(k.id, dates[0] ?? date);
        const previous = dates[1]
          ? await p2.observationsFor(k.id, dates[1])
          : [];
        return {
          tracked_keyword_id: k.id,
          keyword: k.keyword,
          cluster: k.clusterId
            ? (clusterById.get(k.clusterId)?.name ?? null)
            : null,
          priority: k.priority,
          tracking_enabled: k.trackingEnabled,
          alerting_enabled: k.alertingEnabled,
          last_checked_at: k.lastCheckedAt,
          next_check_at: k.nextCheckAt,
          observations: current,
          previous_observations: previous,
        };
      }),
    );
    return json(envelope(config, { rows }, { providerStatus }));
  }

  {
    const match = /^rank-history\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const days = num(Number(url.searchParams.get("days"))) ?? 30;
      const since = new Date(Date.now() - days * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const history = await p2.rankHistory(match[1], since);
      return json(
        envelope(
          config,
          { tracked_keyword_id: match[1], days, history },
          { providerStatus },
        ),
      );
    }
  }

  if (route === "share-of-search" && method === "GET") {
    const days = num(Number(url.searchParams.get("days"))) ?? 30;
    const since = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const history = await p2an.shareHistory(since);
    return json(
      envelope(
        config,
        {
          days,
          // The name matters: this is NOT phase 1's Estimated Organic
          // Visibility Share, and the two must never be conflated.
          metric: "Tracked Keyword Share of Search",
          snapshots: history,
        },
        { providerStatus },
      ),
    );
  }

  if (route === "ranking-events" && method === "GET") {
    const events = await p2an.pendingEvents(50);
    return json(envelope(config, { events }, { providerStatus }));
  }

  if (route === "phase2-cost" && method === "GET") {
    const status = await p2service.phase2CostStatus(config, env);
    return json(envelope(config, status, { providerStatus }));
  }

  return null;
}

/** Operations: the scheduler tick, share recalculation, job inspection. */
async function dispatchP2Operations(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, config, env, providerStatus } = ctx;
  const method = request.method;
  // --- operations ----------------------------------------------------------
  // Morgana owns delivery, so Morgana must tell us what it delivered; without
  // this the same event is handed out on every tick and Slack repeats it.
  if (route === "ranking-events/ack" && method === "POST") {
    const body = await readJson(request);
    const ids = Array.isArray(body.event_ids)
      ? body.event_ids.flatMap((id: unknown) => {
          const value = str(id);
          return value ? [value] : [];
        })
      : [];
    if (ids.length === 0) {
      return badRequest(
        "event_ids_required",
        "event_ids must be a non-empty array",
      );
    }
    await p2an.markNotified(ids);
    return json(
      envelope(config, { acknowledged: ids.length }, { providerStatus }),
    );
  }

  if (route === "rank-tick" && method === "POST") {
    const body = await readJson(request);
    // Optional, and narrowing only: name the keywords a paid submission may buy
    // instead of taking whatever priority order offers. Priority alone will
    // spend on a keyword whose search volume is unknown, which is money bought
    // for a measurement nothing can weight.
    const trackedKeywordIds = Array.isArray(body.tracked_keyword_ids)
      ? body.tracked_keyword_ids.flatMap((id: unknown) => {
          const value = str(id);
          return value ? [value] : [];
        })
      : undefined;
    const result = await p2service.runRankTick(config, env, {
      limit: num(body.limit) ?? 5,
      collectLimit: num(body.collect_limit) ?? 10,
      trackedKeywordIds,
    });
    return json(envelope(config, result, { providerStatus }));
  }

  // The SERP task lifecycle, readable. A queued task is paid work in flight,
  // and "what did I buy and has it arrived" must be answerable without a SQL
  // client — that question is exactly what phase 1 could not answer.
  if (route === "rank-tasks" && method === "GET") {
    const rows = await rankTasks.recentTasks(50);
    return json(
      envelope(
        config,
        {
          tasks: rows.map((task) => ({
            id: task.id,
            job_id: task.jobId,
            tracked_keyword_id: task.trackedKeywordId,
            entity_id: task.entityId,
            // Abbreviated: enough to correlate with the provider, never the
            // whole opaque id in a response that may be logged.
            provider_task_id: task.providerTaskId
              ? `${task.providerTaskId.slice(0, 8)}…`
              : null,
            keyword: task.keyword,
            target_domain: task.targetDomain,
            location_code: task.locationCode,
            language_code: task.languageCode,
            device: task.device,
            search_engine: task.searchEngine,
            collection_window: task.collectionWindow,
            status: task.status,
            attempt_count: task.attemptCount,
            submitted_at: task.submittedAt,
            next_check_at: task.nextCheckAt,
            last_checked_at: task.lastCheckedAt,
            completed_at: task.completedAt,
            error_origin: task.errorOrigin,
            error_class: task.errorClass,
            error_code: task.errorCode,
            endpoint: task.endpoint,
          })),
        },
        { providerStatus },
      ),
    );
  }

  // Redeem one named receipt. The deliberate counterpart to the attempt cap:
  // automatic collection stops so it cannot poll forever, and this collects the
  // result anyway once the provider reports the task complete. Free, and it
  // cannot buy anything — no keyword is selected and no job is created.
  if (route === "rank-recover" && method === "POST") {
    const body = await readJson(request);
    const taskId = str(body.task_id);
    if (!taskId) return json({ error: "task_id is required" }, 400);
    const result = await rankRecovery.recoverRankTaskById(config, taskId);
    return json(envelope(config, result, { providerStatus }));
  }

  {
    const handled = await dispatchKeywordVolume(ctx);
    if (handled) return handled;
  }

  if (route === "share-recalculate" && method === "POST") {
    const result = await p2service.recalculateShareOfSearch();
    return json(envelope(config, result, { providerStatus }));
  }

  if (route === "rank-jobs" && method === "GET") {
    const jobs = await p2jobs.recentJobs(50);
    return json(envelope(config, { jobs }, { providerStatus }));
  }

  // Promote the seed watchlist into editable configuration. Re-runnable: it
  // reports skips rather than creating duplicates, and never touches a row an
  // operator has since changed.
  if (route === "bootstrap-keywords" && method === "POST") {
    const result = await bootstrapTrackedKeywords();
    return json(envelope(config, result, { providerStatus }));
  }

  if (route === "seed-clusters" && method === "POST") {
    const created = await p2.ensureDefaultClusters();
    return json(
      envelope(
        config,
        { created, available: DEFAULT_CLUSTERS.length },
        { providerStatus },
      ),
    );
  }

  return null;
}

export async function dispatchPhase2(
  ctx: SiRequestContext,
): Promise<Response | null> {
  return (
    (await dispatchConfig(ctx)) ??
    (await dispatchP2Reads(ctx)) ??
    (await dispatchP2Operations(ctx))
  );
}
