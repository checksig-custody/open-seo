import {
  badRequest,
  envelope,
  isRecord,
  json,
  num,
  readJson,
  str,
} from "./http";
import * as store from "./backlink-store";
import * as anchorStore from "./backlink-anchor-store";
import * as findingsStore from "./backlink-findings-store";
import * as service from "./backlink-service";
import { recomputeBacklinkGap } from "./backlink-events";
import { backlinkCostStatus } from "./backlink-cost";
import {
  clearBrandProtectionSignals,
  setBrandProtectionSignals,
} from "./brand-protection";
import type { SiRequestContext } from "./router";

/**
 * Morgana Search Intelligence — phase 3 routes.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Mounted under the same private `/internal/si/` prefix. Split into reads and
 * operations for the same reason phase 2 was: one dispatcher covering both
 * exceeds the repo's complexity limit and stops being readable long before it
 * exceeds it.
 */

const today = () => new Date().toISOString().slice(0, 10);

function parseReasons(raw: string | null): unknown {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed stored blob is dropped rather than propagated: the UI would
    // render it, and it is our own column, so an unparseable value is a bug we
    // should not compound by shipping it to the browser.
    return [];
  }
}

/** Shape a stored finding for the wire, decoding the JSON columns. */
function findingPayload(row: findingsStore.BacklinkEventRow) {
  return {
    id: row.id,
    event_type: row.eventType,
    entity_id: row.entityId,
    subject_domain: row.subjectDomain,
    severity: row.severity,
    channel: row.channel,
    status: row.status,
    risk_score: row.riskScore,
    risk_classification: row.riskClassification,
    reasons: parseReasons(row.reasons),
    brand_protection_signals: parseReasons(row.brandProtectionSignals),
    brand_protection_status: row.brandProtectionStatus,
    detected_at: row.detectedAt,
    delivered_at: row.deliveredAt,
    review_status: row.reviewStatus,
    reviewed_by: row.reviewedBy,
    reviewed_at: row.reviewedAt,
    review_note: row.reviewNote,
  };
}

async function dispatchBacklinkReads(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, url, config, env, providerStatus } = ctx;
  const method = request.method;

  {
    const match = /^backlinks\/overview\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const entityId = match[1];
      const [snapshot, domains, anchors] = await Promise.all([
        store.latestSnapshot(entityId),
        store.listReferringDomains(entityId, { status: "active", limit: 10 }),
        anchorStore.latestAnchors(entityId, 10),
      ]);
      return json(
        envelope(
          config,
          {
            entity_id: entityId,
            snapshot: snapshot ?? null,
            top_referring_domains: domains,
            top_anchors: anchors,
          },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^backlinks\/history\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const days = num(Number(url.searchParams.get("days"))) ?? 90;
      const since = new Date(Date.now() - days * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const history = await store.snapshotHistory(match[1], since);
      return json(
        envelope(
          config,
          { entity_id: match[1], days, history },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^backlinks\/list\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const status = url.searchParams.get("status");
      const limit = Math.min(
        500,
        num(Number(url.searchParams.get("limit"))) ?? 200,
      );
      if (status === "new") {
        const days = num(Number(url.searchParams.get("days"))) ?? 30;
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const rows = await store.backlinksFirstSeenSince(
          match[1],
          since,
          limit,
        );
        return json(
          envelope(
            config,
            { entity_id: match[1], status: "new", backlinks: rows },
            { providerStatus },
          ),
        );
      }
      const resolved = status === "lost" ? "lost" : "active";
      const rows = await store.backlinksByStatus(match[1], resolved, limit);
      return json(
        envelope(
          config,
          { entity_id: match[1], status: resolved, backlinks: rows },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^backlinks\/referring-domains\/([A-Za-z0-9_-]{1,64})$/.exec(
      route,
    );
    if (match?.[1] && method === "GET") {
      const status =
        url.searchParams.get("status") === "lost" ? "lost" : "active";
      const rows = await store.listReferringDomains(match[1], {
        status,
        limit: 250,
      });
      return json(
        envelope(
          config,
          { entity_id: match[1], status, domains: rows },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^backlinks\/anchors\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const rows = await anchorStore.latestAnchors(match[1], 100);
      return json(
        envelope(
          config,
          { entity_id: match[1], anchors: rows },
          { providerStatus },
        ),
      );
    }
  }

  if (route === "backlinks/gap" && method === "GET") {
    const requested = str(url.searchParams.get("date"));
    const date =
      requested ?? (await findingsStore.mostRecentGapDate()) ?? today();
    const rows = await findingsStore.latestGap(date);
    return json(
      envelope(
        config,
        {
          snapshot_date: date,
          rows: rows.map((row) => ({
            ...row,
            competitor_entity_ids: parseReasons(row.competitorEntityIds),
          })),
        },
        { providerStatus },
      ),
    );
  }

  if (route === "backlinks/findings" && method === "GET") {
    const reviewStatus = str(url.searchParams.get("reviewStatus"));
    const rows = await findingsStore.listFindings({
      reviewStatus: isReviewStatus(reviewStatus) ? reviewStatus : undefined,
      minRisk: num(Number(url.searchParams.get("minRisk"))) ?? undefined,
    });
    const counts = await findingsStore.findingCounts();
    return json(
      envelope(
        config,
        { findings: rows.map(findingPayload), counts },
        { providerStatus },
      ),
    );
  }

  {
    const match = /^backlinks\/findings\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const row = await findingsStore.getFinding(match[1]);
      if (!row) return json({ error: "finding not found" }, 404);
      return json(
        envelope(config, { finding: findingPayload(row) }, { providerStatus }),
      );
    }
  }

  if (route === "backlinks/events" && method === "GET") {
    const events = await findingsStore.pendingBacklinkEvents(50);
    return json(
      envelope(
        config,
        { events: events.map(findingPayload) },
        { providerStatus },
      ),
    );
  }

  if (route === "backlinks/cost" && method === "GET") {
    const status = await backlinkCostStatus(config, env);
    return json(envelope(config, status, { providerStatus }));
  }

  return null;
}

const REVIEW_STATUSES = [
  "new",
  "reviewing",
  "confirmed_benign",
  "confirmed_suspicious",
  "escalated",
  "dismissed",
] as const;

function isReviewStatus(
  value: unknown,
): value is (typeof REVIEW_STATUSES)[number] {
  return (
    typeof value === "string" &&
    (REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

async function dispatchBacklinkOperations(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, config, env, providerStatus } = ctx;
  const method = request.method;

  if (route === "backlinks/refresh" && method === "POST") {
    const body = await readJson(request);
    const entityId = str(body.entity_id);
    if (!entityId)
      return badRequest("entity_id_required", "entity_id is required");

    // Morgana owns brand-protection data and hands it over per request; the
    // engine has no access to Morgana's database and must not acquire any.
    const signals = Array.isArray(body.brand_protection_signals)
      ? body.brand_protection_signals.flatMap((entry: unknown) => {
          if (!isRecord(entry)) return [];
          const domain = str(entry.domain);
          if (!domain) return [];
          const counts = isRecord(entry.counts) ? entry.counts : {};
          return [
            {
              domain,
              counts: {
                mentionCount: num(counts.mention_count) ?? 0,
                telegramMentionCount: num(counts.telegram_mention_count) ?? 0,
                socialMentionCount: num(counts.social_mention_count) ?? 0,
                negativeSentimentCount:
                  num(counts.negative_sentiment_count) ?? 0,
                existingImpersonationFindings:
                  num(counts.existing_impersonation_findings) ?? 0,
              },
              references: Array.isArray(entry.references)
                ? entry.references.flatMap((reference: unknown) => {
                    const value = str(reference);
                    return value ? [value] : [];
                  })
                : [],
            },
          ];
        })
      : [];
    setBrandProtectionSignals(signals);
    try {
      const result = await service.refreshBacklinks(config, env, entityId, {
        limits: {
          backlinks: num(body.backlink_limit) ?? undefined,
          referringDomains: num(body.referring_domain_limit) ?? undefined,
          anchors: num(body.anchor_limit) ?? undefined,
        },
      });
      return json(envelope(config, result, { providerStatus }));
    } finally {
      // Always cleared: a leaked registry would attribute one refresh's signals
      // to the next entity refreshed in the same isolate.
      clearBrandProtectionSignals();
    }
  }

  if (route === "backlinks/gap-recalculate" && method === "POST") {
    const result = await recomputeBacklinkGap();
    return json(envelope(config, result, { providerStatus }));
  }

  if (route === "backlinks/events/ack" && method === "POST") {
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
    await findingsStore.markEventsDelivered(ids);
    return json(
      envelope(config, { acknowledged: ids.length }, { providerStatus }),
    );
  }

  {
    const match = /^backlinks\/findings\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "PATCH") {
      const body = await readJson(request);
      const reviewStatus = body.review_status;
      if (reviewStatus !== undefined && !isReviewStatus(reviewStatus)) {
        return badRequest(
          "bad_review_status",
          `review_status must be one of ${REVIEW_STATUSES.join(", ")}`,
        );
      }
      const updated = await findingsStore.updateFindingReview(match[1], {
        reviewStatus: isReviewStatus(reviewStatus) ? reviewStatus : undefined,
        reviewedBy: str(body.reviewed_by) ?? null,
        reviewNote:
          body.review_note === null
            ? null
            : (str(body.review_note) ?? undefined),
      });
      if (!updated) return json({ error: "finding not found" }, 404);
      return json(
        envelope(
          config,
          { finding: findingPayload(updated) },
          { providerStatus },
        ),
      );
    }
  }

  return null;
}

export async function dispatchPhase3(
  ctx: SiRequestContext,
): Promise<Response | null> {
  return (
    (await dispatchBacklinkReads(ctx)) ??
    (await dispatchBacklinkOperations(ctx))
  );
}
