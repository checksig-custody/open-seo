import {
  badRequest,
  envelope,
  isRecord,
  json,
  num,
  readJson,
  str,
} from "./http";
import * as graph from "./graph-store";
import * as store from "./correlation-store";
import * as service from "./correlation-service";
import * as momentum from "./correlation-momentum";
import type { SiRequestContext } from "./router";

/**
 * Morgana Search Intelligence — phase 4 campaign, reputation and tick routes.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Split from p4-router to stay inside the 400-line module limit; the graph
 * reads live there, the correlation surface lives here.
 */

const REVIEW_STATUSES = [
  "new",
  "reviewing",
  "confirmed",
  "dismissed",
  "resolved",
] as const;

const CAMPAIGN_STATUSES = [
  "candidate",
  "active",
  "confirmed",
  "ended",
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

function isCampaignStatus(
  value: unknown,
): value is (typeof CAMPAIGN_STATUSES)[number] {
  return (
    typeof value === "string" &&
    (CAMPAIGN_STATUSES as readonly string[]).includes(value)
  );
}

function parseStatus(
  raw: string | null,
): (typeof REVIEW_STATUSES)[number] | undefined {
  return isReviewStatus(raw) ? raw : undefined;
}

const BRAND_FACT_KINDS = ["mention", "article", "telegram", "social"] as const;

function isBrandFactKind(
  value: unknown,
): value is (typeof BRAND_FACT_KINDS)[number] {
  return (
    typeof value === "string" &&
    (BRAND_FACT_KINDS as readonly string[]).includes(value)
  );
}

const SENTIMENTS = ["positive", "neutral", "negative"] as const;

function isSentiment(value: unknown): value is (typeof SENTIMENTS)[number] {
  return (
    typeof value === "string" &&
    (SENTIMENTS as readonly string[]).includes(value)
  );
}

const NODE_TYPES = [
  "brand",
  "competitor",
  "domain",
  "page",
  "keyword",
  "mention",
  "article",
  "backlink",
  "referring_domain",
  "telegram_channel",
  "social_profile",
  "campaign",
  "finding",
] as const;

function asNodeType(value: unknown) {
  return typeof value === "string" &&
    (NODE_TYPES as readonly string[]).includes(value)
    ? (NODE_TYPES.find((candidate) => candidate === value) ?? undefined)
    : undefined;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function dispatchCorrelationReads(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, url, config, providerStatus } = ctx;
  const method = request.method;

  if (route === "campaigns" && method === "GET") {
    const days = Math.min(365, num(Number(url.searchParams.get("days"))) ?? 30);
    const campaigns = await store.listCampaigns({
      since: new Date(Date.now() - days * 86_400_000).toISOString(),
    });
    return json(
      envelope(
        config,
        {
          campaigns: campaigns.map((campaign) => ({
            ...campaign,
            entities: parseJson(campaign.entities),
          })),
        },
        { providerStatus },
      ),
    );
  }

  {
    const match = /^campaigns\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const campaign = await store.getCampaign(match[1]);
      if (!campaign) return json({ error: "campaign not found" }, 404);
      const [signals, evidence] = await Promise.all([
        store.campaignSignals(campaign.id),
        graph.evidenceFor("campaign", campaign.id),
      ]);
      return json(
        envelope(
          config,
          {
            campaign: { ...campaign, entities: parseJson(campaign.entities) },
            signals,
            evidence,
          },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^momentum\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const result = await momentum.competitorMomentum(match[1]);
      return json(
        envelope(
          config,
          { entity_id: match[1], momentum: result },
          { providerStatus },
        ),
      );
    }
  }

  if (route === "reputation" && method === "GET") {
    const findings = await store.listReputationFindings({
      status: parseStatus(url.searchParams.get("status")),
      limit: 100,
    });
    return json(
      envelope(
        config,
        {
          findings: findings.map((finding) => ({
            ...finding,
            signals: parseJson(finding.signals),
            affectedEntities: parseJson(finding.affectedEntities),
          })),
        },
        { providerStatus },
      ),
    );
  }

  {
    const match = /^reputation\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "GET") {
      const finding = await store.getReputationFinding(match[1]);
      if (!finding) return json({ error: "finding not found" }, 404);
      const evidence = await graph.evidenceFor("finding", finding.id);
      return json(
        envelope(
          config,
          {
            finding: {
              ...finding,
              signals: parseJson(finding.signals),
              affectedEntities: parseJson(finding.affectedEntities),
            },
            evidence,
          },
          { providerStatus },
        ),
      );
    }
  }

  if (route === "phase4-status" && method === "GET") {
    const status = await momentum.phase4Status();
    return json(envelope(config, status, { providerStatus }));
  }

  if (route === "reputation-alerts" && method === "GET") {
    const alerts = await store.pendingReputationAlerts(25);
    return json(
      envelope(
        config,
        {
          alerts: alerts.map((alert) => ({
            ...alert,
            signals: parseJson(alert.signals),
          })),
        },
        { providerStatus },
      ),
    );
  }

  return null;
}

export async function dispatchCorrelationOperations(
  ctx: SiRequestContext,
): Promise<Response | null> {
  const { route, request, config, providerStatus } = ctx;
  const method = request.method;

  if (route === "correlation-tick" && method === "POST") {
    const body = await readJson(request);
    // Brand facts travel INBOUND: the engine has no access to Morgana's data.
    const brandFacts = Array.isArray(body.brand_facts)
      ? body.brand_facts.flatMap((entry: unknown) => {
          if (!isRecord(entry)) return [];
          const externalId = str(entry.external_id);
          const observedAt = str(entry.observed_at);
          const kind = entry.kind;
          if (!externalId || !observedAt) return [];
          // A predicate, not a chain of !== checks: excluding four literals
          // from `string` does not narrow `string`, so TypeScript would keep
          // widening it back and the cast would be doing the real work.
          if (!isBrandFactKind(kind)) return [];
          const sentiment = str(entry.sentiment);
          return [
            {
              kind,
              externalId,
              url: str(entry.url) ?? null,
              title: str(entry.title) ?? null,
              sourceName: str(entry.source_name) ?? null,
              channel: str(entry.channel) ?? null,
              sentiment: isSentiment(sentiment) ? sentiment : null,
              observedAt,
            },
          ];
        })
      : [];
    const result = await service.runCorrelationTick({ brandFacts });
    return json(envelope(config, result, { providerStatus }));
  }

  if (route === "timeline-compaction" && method === "POST") {
    const body = await readJson(request);
    const removed = await momentum.compactTimeline(
      num(body.retention_days) ?? 180,
    );
    return json(envelope(config, { removed }, { providerStatus }));
  }

  if (route === "reputation-alerts/ack" && method === "POST") {
    const body = await readJson(request);
    const ids = Array.isArray(body.finding_ids)
      ? body.finding_ids.flatMap((id: unknown) => {
          const value = str(id);
          return value ? [value] : [];
        })
      : [];
    if (ids.length === 0)
      return badRequest(
        "finding_ids_required",
        "finding_ids must be a non-empty array",
      );
    const suppressionReason = str(body.suppression_reason);
    if (suppressionReason)
      await store.markAlertsSuppressed(ids, suppressionReason);
    else await store.markAlertsDelivered(ids);
    return json(
      envelope(config, { acknowledged: ids.length }, { providerStatus }),
    );
  }

  {
    const match = /^campaigns\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "PATCH") {
      const body = await readJson(request);
      const status = body.status;
      if (status !== undefined && !isCampaignStatus(status)) {
        return badRequest(
          "bad_status",
          `status must be one of ${CAMPAIGN_STATUSES.join(", ")}`,
        );
      }
      const updated = await store.updateCampaignStatus(match[1], {
        status: isCampaignStatus(status) ? status : undefined,
        reviewedBy: str(body.reviewed_by) ?? null,
        reviewNote:
          body.review_note === null
            ? null
            : (str(body.review_note) ?? undefined),
      });
      if (!updated) return json({ error: "campaign not found" }, 404);
      return json(
        envelope(
          config,
          { campaign: { ...updated, entities: parseJson(updated.entities) } },
          { providerStatus },
        ),
      );
    }
  }

  {
    const match = /^reputation\/([A-Za-z0-9_-]{1,64})$/.exec(route);
    if (match?.[1] && method === "PATCH") {
      const body = await readJson(request);
      const status = body.status;
      if (status !== undefined && !isReviewStatus(status)) {
        return badRequest(
          "bad_status",
          `status must be one of ${REVIEW_STATUSES.join(", ")}`,
        );
      }
      const updated = await store.updateReputationFinding(match[1], {
        status: isReviewStatus(status) ? status : undefined,
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
          {
            finding: {
              ...updated,
              signals: parseJson(updated.signals),
              affectedEntities: parseJson(updated.affectedEntities),
            },
          },
          { providerStatus },
        ),
      );
    }
  }

  if (route === "graph/resolve" && method === "POST") {
    const body = await readJson(request);
    const nodeType = asNodeType(body.node_type);
    const value = str(body.value);
    if (!nodeType || !value)
      return badRequest(
        "node_type_value_required",
        "node_type and value are required",
      );
    const node = await momentum.resolveNode(nodeType, value);
    return json(envelope(config, { node: node ?? null }, { providerStatus }));
  }

  return null;
}
