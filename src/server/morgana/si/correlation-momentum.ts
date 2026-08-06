import { and, gte, eq } from "drizzle-orm";
import { db } from "@/db";
import { siBacklinks, siRankSnapshots, siReferringDomains } from "@/db/schema";
import * as graph from "./graph-store";
import * as timeline from "./graph-timeline-store";
import * as store from "./correlation-store";
import {
  computeMomentum,
  correlateReputation,
  escalateImpersonation,
  type MomentumResult,
  type ReputationSignal,
} from "./correlation";
import { canonicalise } from "./graph-model";

/**
 * Morgana Search Intelligence — phase 4 momentum, reputation and timeline.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Split from correlation-service to stay inside the 400-line module limit.
 * Everything here reads already-stored records and writes derived output, so
 * none of it can spend.
 */

const DAY_MS = 86_400_000;

// --- momentum ---------------------------------------------------------------

/**
 * Momentum for one entity, from data already collected.
 *
 * Every input is nullable and stays null when unmeasured — a competitor whose
 * sentiment we have never sampled is not one with flat sentiment.
 */
export async function competitorMomentum(
  entityId: string,
  now = new Date(),
): Promise<MomentumResult> {
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const previousSince = new Date(now.getTime() - 60 * DAY_MS).toISOString();

  const recentBacklinks = await db
    .select()
    .from(siBacklinks)
    .where(
      and(
        eq(siBacklinks.targetEntityId, entityId),
        gte(siBacklinks.firstSeenAt, since),
      ),
    );
  const olderBacklinks = await db
    .select()
    .from(siBacklinks)
    .where(
      and(
        eq(siBacklinks.targetEntityId, entityId),
        gte(siBacklinks.firstSeenAt, previousSince),
      ),
    );

  const priorCount = olderBacklinks.length - recentBacklinks.length;
  const backlinkGrowth =
    priorCount > 0 ? (recentBacklinks.length - priorCount) / priorCount : null;

  const recentDomains = await db
    .select()
    .from(siReferringDomains)
    .where(
      and(
        eq(siReferringDomains.entityId, entityId),
        gte(siReferringDomains.firstSeenAt, since),
      ),
    );

  const ranks = await db
    .select()
    .from(siRankSnapshots)
    .where(
      and(
        eq(siRankSnapshots.entityId, entityId),
        gte(siRankSnapshots.createdAt, since),
      ),
    );
  const found = ranks.filter((row) => row.isFound);
  const rankGains =
    ranks.length === 0 ? null : found.length / ranks.length - 0.5;

  const campaigns = await store.listCampaigns({ since });
  const activeForEntity = campaigns.filter(
    (campaign) => campaign.subjectEntityId === entityId,
  );

  return computeMomentum({
    backlinkGrowth,
    // Null rather than 0 when nothing was collected: no observation is not the
    // observation of no growth.
    newReferringDomains:
      recentDomains.length > 0 ? recentDomains.length / 10 : null,
    rankGains,
    newKeywords: ranks.length > 0 ? found.length / 20 : null,
    activeCampaigns:
      activeForEntity.length > 0 ? activeForEntity.length / 3 : null,
    mentionTrend: null,
    sentimentTrend: null,
    visibilityTrend: null,
  });
}

// --- reputation -------------------------------------------------------------

/**
 * Correlate reputation signals across the graph.
 *
 * The interesting case is a suspicious domain that ALSO appears in mentions or
 * on Telegram: phase 3 could see the domain, but only phase 4 can see that
 * something unrelated agrees with it.
 */
export async function correlateReputationSignals(now: Date): Promise<number> {
  const suspicious = await db
    .select()
    .from(siReferringDomains)
    .where(
      and(
        eq(siReferringDomains.status, "active"),
        gte(siReferringDomains.riskScore, 50),
      ),
    );

  let created = 0;
  for (const domain of suspicious) {
    // Does anything outside the backlink data know this domain?
    const domainNode = await graph.findNode(
      "referring_domain",
      domain.normalizedDomain,
    );
    const neighbours = domainNode
      ? await graph.neighboursOf(domainNode.id, { limit: 50 })
      : [];
    const neighbourNodes = await graph.getNodes(
      neighbours.map((neighbour) => neighbour.nodeId),
    );

    const telegramCount = neighbourNodes.filter(
      (node) => node.nodeType === "telegram_channel",
    ).length;
    const socialCount = neighbourNodes.filter(
      (node) => node.nodeType === "social_profile",
    ).length;
    const mentionCount = neighbourNodes.filter(
      (node) => node.nodeType === "mention" || node.nodeType === "article",
    ).length;

    const escalated = escalateImpersonation({
      baseRiskScore: domain.riskScore ?? 50,
      baseFamilies: 1,
      telegramCount,
      socialCount,
      mentionCount,
      backlinkActivity: domain.backlinkCount,
    });

    const signals: ReputationSignal[] = [
      {
        type: "backlink_risk",
        family: "identity",
        reason: `rischio backlink ${String(domain.riskScore ?? 0)}/100 su ${domain.domain}`,
        weight: Math.min(40, domain.riskScore ?? 0),
        observedAt: domain.lastSeenAt,
      },
      ...escalated.signals,
    ];

    const result = correlateReputation({
      category: "possible_impersonation",
      signals,
    });
    // Null when only the backlink evidence exists — phase 3 already reported
    // that, and repeating it here as a "correlation" would be noise.
    if (!result) continue;

    const findingId = await store.saveReputationFinding(result, {
      subjectLabel: domain.domain,
      affectedEntities: domainNode ? [domainNode.id] : [],
      now,
    });
    if (!findingId) continue;
    created += 1;
    for (const signal of result.signals) {
      await graph.recordEvidence({
        subjectType: "finding",
        subjectId: findingId,
        evidenceType: signal.type,
        sourceRecordId: domain.id,
        sourceSystem: "derived",
        observedAt: signal.observedAt,
        reason: signal.reason,
      });
    }
  }

  return created;
}

// --- timeline ---------------------------------------------------------------

/** Project campaigns and findings onto the shared timeline. */
export async function projectTimeline(now: Date): Promise<number> {
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const events: timeline.TimelineInput[] = [];

  for (const campaign of await store.listCampaigns({ since })) {
    events.push({
      occurredAt: campaign.lastActivityAt,
      eventType: "campaign_event",
      entityLabel: campaign.subjectLabel,
      summary: `campagna ${campaign.category} con ${String(campaign.signalCount)} segnali`,
      severity:
        campaign.category === "possible_impersonation_campaign"
          ? "warning"
          : "notice",
      sourceSystem: "derived",
      sourceRecordId: campaign.id,
    });
  }

  for (const finding of await store.listReputationFindings({ limit: 100 })) {
    events.push({
      occurredAt: finding.lastSeenAt,
      eventType: "finding",
      entityLabel: finding.subjectLabel,
      summary: `finding ${finding.category} (${finding.severity})`,
      severity:
        finding.severity === "critical"
          ? "critical"
          : finding.severity === "high"
            ? "warning"
            : "notice",
      sourceSystem: "derived",
      sourceRecordId: finding.id,
    });
  }

  return timeline.appendTimelineEvents(events);
}

/** Retention sweep. The timeline is derived, so compaction loses no evidence. */
export async function compactTimeline(
  retentionDays = 180,
  now = new Date(),
): Promise<number> {
  return timeline.compactTimeline(
    new Date(now.getTime() - retentionDays * DAY_MS).toISOString(),
  );
}

export async function phase4Status(): Promise<{
  costCentre: string;
  graph: Awaited<ReturnType<typeof graph.graphCounts>>;
  checkpoints: Awaited<ReturnType<typeof timeline.listCheckpoints>>;
  campaigns: number;
  findings: number;
  /** Phase 4 correlates already-collected data; it cannot spend. */
  providerCallsMade: number;
  estimatedCostUsd: number;
  lastRunAt: string | null;
}> {
  const counts = await graph.graphCounts();
  const checkpoints = await timeline.listCheckpoints();
  const campaigns = await store.listCampaigns({ limit: 500 });
  const findings = await store.listReputationFindings({ limit: 500 });
  return {
    costCentre: "search_graph_correlation",
    graph: counts,
    checkpoints,
    campaigns: campaigns.length,
    findings: findings.length,
    providerCallsMade: 0,
    estimatedCostUsd: 0,
    lastRunAt:
      checkpoints
        .map((checkpoint) => checkpoint.lastRunAt)
        .filter((value): value is string => value !== null)
        .toSorted((a, b) => a.localeCompare(b))
        .at(-1) ?? null,
  };
}

/** Resolve a label to a graph node, for the UI's search box. */
export async function resolveNode(
  nodeType: Parameters<typeof canonicalise>[0],
  raw: string,
) {
  const canonical = canonicalise(nodeType, raw);
  if (!canonical) return undefined;
  return graph.findNode(nodeType, canonical);
}
