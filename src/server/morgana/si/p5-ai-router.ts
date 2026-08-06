import {
  badRequest,
  bool,
  clamp,
  envelope,
  json,
  num,
  readJson,
  str,
} from "./http";
import * as store from "./ai-visibility-store";
import * as service from "./ai-visibility-service";
import { citationDelta, computeMetrics } from "./ai-visibility";
import type { SiRequestContext } from "./router";

/**
 * Morgana Search Intelligence — phase 5 AI Visibility routes.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Every response carries `providerStatus` and the row-level `source`, so a
 * caller can always tell fixture data from measured data. That is not a nicety:
 * this surface reports on whether an AI answer cited us, and a synthetic answer
 * presented as an observation would be the most misleading thing in the
 * product.
 */

const PRIORITIES = ["critical", "high", "normal", "low"] as const;

function isPriority(value: unknown): value is (typeof PRIORITIES)[number] {
  return (
    typeof value === "string" &&
    (PRIORITIES as readonly string[]).includes(value)
  );
}

export async function dispatchAiVisibility(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, url, config, env, providerStatus } = ctx;
  const method = request.method;

  if (route === "ai-visibility/overview" && method === "GET") {
    const overview = await service.aiVisibilityOverview(config, env);
    return json(envelope(config, overview, { providerStatus }));
  }

  if (route === "ai-visibility/queries" && method === "GET") {
    const queries = await store.listQueries({ includeDisabled: true });
    return json(
      envelope(
        config,
        {
          queries: queries.map((query) => ({
            id: query.id,
            query: query.query,
            cluster: query.cluster,
            priority: query.priority,
            locationCode: query.locationCode,
            languageCode: query.languageCode,
            enabled: query.enabled,
            checkIntervalHours: query.checkIntervalHours,
            lastCheckedAt: query.lastCheckedAt,
          })),
        },
        { providerStatus },
      ),
    );
  }

  if (route === "ai-visibility/citations" && method === "GET") {
    const citations = await store.recentCitations(
      clamp(url.searchParams.get("days"), 30, 365) ?? 30,
    );
    return json(
      envelope(
        config,
        {
          citations: citations.slice(0, 500).map((citation) => ({
            id: citation.id,
            queryId: citation.queryId,
            domain: citation.domain,
            normalizedDomain: citation.normalizedDomain,
            url: citation.url,
            entityId: citation.entityId,
            citationOrder: citation.citationOrder,
            title: citation.title,
            firstSeenAt: citation.firstSeenAt,
          })),
        },
        { providerStatus },
      ),
    );
  }

  if (route === "ai-visibility/history" && method === "GET") {
    const days = clamp(url.searchParams.get("days"), 30, 365) ?? 30;
    const snapshots = await store.latestSnapshots({ days });
    const queries = await store.listQueries();
    // Grouped by day so the trend line is a series rather than a scatter.
    const byDay = new Map<string, typeof snapshots>();
    for (const snapshot of snapshots) {
      const day = snapshot.checkedAt.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), snapshot]);
    }
    const points = [...byDay.entries()]
      .toSorted((a, b) => a[0].localeCompare(b[0]))
      .map(([day, rows]) => {
        const metrics = computeMetrics(
          rows.map((row) => ({
            queryId: row.queryId,
            priority: "normal" as const,
            aiResultPresent: row.aiResultPresent,
            primaryBrandMentioned: row.primaryBrandMentioned,
            primaryBrandCited: row.primaryBrandCited,
            competitorMentions: row.competitorMentions,
            competitorCitations: row.competitorCitations,
            citedDomainCount: row.citedDomainCount,
            checkedAt: row.checkedAt,
          })),
          [],
          queries.length,
        );
        return {
          day,
          queriesObserved: metrics.queriesObserved,
          queriesWithAiResult: metrics.queriesWithAiResult,
          queriesWithBrandMention: metrics.queriesWithBrandMention,
          queriesWithBrandCitation: metrics.queriesWithBrandCitation,
        };
      });
    return json(envelope(config, { days, points }, { providerStatus }));
  }

  if (route === "ai-visibility/cost" && method === "GET") {
    const status = await service.aiCostStatus(config, env);
    return json(envelope(config, status, { providerStatus }));
  }

  if (route === "ai-visibility/events" && method === "GET") {
    const events = await store.pendingEvents(
      clamp(url.searchParams.get("limit"), 25, 100) ?? 25,
    );
    return json(
      envelope(
        config,
        {
          events: events.map((event) => ({
            id: event.id,
            queryId: event.queryId,
            eventType: event.eventType,
            severity: event.severity,
            domain: event.domain,
            magnitude: event.magnitude,
            reason: event.reason,
            channel: event.channel,
            deliveryStatus: event.deliveryStatus,
            occurredAt: event.occurredAt,
          })),
        },
        { providerStatus },
      ),
    );
  }

  {
    const match = /^ai-visibility\/delta\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const snapshots = await store.latestSnapshots({
        days: 90,
        queryId: match[1],
      });
      const [current, previous] = snapshots;
      if (!current) {
        return json(
          envelope(
            config,
            { queryId: match[1], delta: { gained: [], lost: [] } },
            { providerStatus },
          ),
        );
      }
      const [currentCitations, previousCitations] = await Promise.all([
        store.citationsFor([current.id]),
        previous ? store.citationsFor([previous.id]) : Promise.resolve([]),
      ]);
      return json(
        envelope(
          config,
          {
            queryId: match[1],
            delta: citationDelta(
              service.toCitationFacts(currentCitations),
              service.toCitationFacts(previousCitations),
            ),
          },
          { providerStatus },
        ),
      );
    }
  }

  return null;
}

export async function dispatchAiVisibilityOperations(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, config, env, providerStatus } = ctx;
  const method = request.method;

  if (route === "ai-visibility/queries" && method === "POST") {
    const body = await readJson(request);
    const query = str(body.query);
    if (!query) return badRequest("query_required", "query is required");
    const priority = body.priority;
    if (priority !== undefined && !isPriority(priority)) {
      return badRequest(
        "bad_priority",
        `priority must be one of ${PRIORITIES.join(", ")}`,
      );
    }
    const created = await store.createQuery({
      query,
      cluster: str(body.cluster) ?? null,
      priority: isPriority(priority) ? priority : undefined,
      locationCode: num(body.location_code),
      languageCode: str(body.language_code),
      checkIntervalHours: num(body.check_interval_hours),
    });
    return json(envelope(config, { query: created }, { providerStatus }), 201);
  }

  if (route === "ai-visibility/seed" && method === "POST") {
    const created = await store.seedQueries();
    return json(envelope(config, { created }, { providerStatus }));
  }

  if (route === "ai-visibility/refresh" && method === "POST") {
    const body = await readJson(request);
    const queryId = str(body.query_id);
    if (queryId) {
      const outcome = await service.refreshQuery(config, env, queryId);
      return json(envelope(config, { outcome }, { providerStatus }));
    }
    const result = await service.runAiVisibilityTick(
      config,
      env,
      num(body.limit) ?? 5,
    );
    return json(envelope(config, result, { providerStatus }));
  }

  if (route === "ai-visibility/events/ack" && method === "POST") {
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
    const suppressionReason = str(body.suppression_reason);
    if (suppressionReason)
      await store.markEventsSuppressed(ids, suppressionReason);
    else await store.markEventsDelivered(ids);
    return json(
      envelope(config, { acknowledged: ids.length }, { providerStatus }),
    );
  }

  {
    const match = /^ai-visibility\/queries\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "PATCH") {
      const body = await readJson(request);
      const priority = body.priority;
      if (priority !== undefined && !isPriority(priority)) {
        return badRequest(
          "bad_priority",
          `priority must be one of ${PRIORITIES.join(", ")}`,
        );
      }
      const updated = await store.updateQuery(match[1], {
        priority: isPriority(priority) ? priority : undefined,
        cluster:
          body.cluster === null ? null : (str(body.cluster) ?? undefined),
        enabled: bool(body.enabled),
        checkIntervalHours: num(body.check_interval_hours),
      });
      if (!updated) return json({ error: "query not found" }, 404);
      return json(envelope(config, { query: updated }, { providerStatus }));
    }
  }

  return null;
}
