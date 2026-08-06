import { and, gte, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  siBacklinks,
  siRankSnapshots,
  siReferringDomains,
  siTimelineEvents,
} from "@/db/schema";
import * as graph from "./graph-store";
import * as timeline from "./graph-timeline-store";
import * as store from "./correlation-store";
import {
  correlateReputationSignals,
  projectTimeline,
} from "./correlation-momentum";
import * as ingest from "./graph-ingest";
import * as ingestP5 from "./graph-ingest-p5";
import * as entityStore from "./store";
import { detectCampaign, type Signal } from "./correlation";

/**
 * Morgana Search Intelligence — phase 4 correlation orchestration.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * One tick: ingest what is new → detect campaigns → recompute momentum →
 * correlate reputation. Order matters — campaigns and reputation both read the
 * graph the ingestion step just updated, so running them first would correlate
 * yesterday's picture.
 *
 * Nothing here spends. Every input was already paid for by phases 1–3.
 */

const DAY_MS = 86_400_000;

interface CorrelationTickResult {
  ingested: ingest.IngestResult[];
  campaignsDetected: number;
  reputationFindings: number;
  timelineEvents: number;
  skipped?: string;
}

/**
 * Run one correlation pass.
 *
 * `brandFacts` arrive from Morgana on the request: the engine has no access to
 * Morgana's database and must not acquire any.
 */
export async function runCorrelationTick(
  options: { brandFacts?: readonly ingest.BrandFact[]; now?: Date } = {},
): Promise<CorrelationTickResult> {
  const now = options.now ?? new Date();
  const ingested: ingest.IngestResult[] = [];

  const entityResult = await ingest.ingestEntities();
  ingested.push(entityResult);

  if (options.brandFacts?.length) {
    const brandResult = await ingest.ingestBrandFacts(options.brandFacts);
    ingested.push(brandResult);
    await timeline.saveCheckpoint({
      sourceKey: brandResult.source,
      cursor: brandResult.cursor,
      status: brandResult.status,
      recordsProcessed: brandResult.processed,
    });
  }

  for (const step of [
    ingest.ingestSearchData,
    ingest.ingestBacklinkData,
    ingest.ingestFindings,
    // Phase 5. Appended rather than interleaved: audit and AI data are the
    // cheapest sources to ingest and the least urgent, so they run last and a
    // partial pass simply resumes on the next tick.
    ingestP5.ingestAuditData,
    ingestP5.ingestAuditIssues,
    ingestP5.ingestAiVisibility,
  ]) {
    const result = await step();
    ingested.push(result);
    await timeline.saveCheckpoint({
      sourceKey: result.source,
      cursor: result.cursor,
      status: result.status,
      recordsProcessed: result.processed,
    });
  }

  const campaignsDetected = await detectCampaigns(now);
  const reputationFindings = await correlateReputationSignals(now);
  const timelineEvents = await projectTimeline(now);

  return { ingested, campaignsDetected, reputationFindings, timelineEvents };
}

// --- campaigns --------------------------------------------------------------

/**
 * Gather this window's signals per entity and hand them to the detector.
 *
 * Every signal is derived from records already stored, so this is pure reading.
 */
async function detectCampaigns(now: Date): Promise<number> {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const entities = await entityStore.listEntities();
  let detected = 0;

  for (const entity of entities) {
    const signals: Signal[] = [];

    const backlinks = await db
      .select()
      .from(siBacklinks)
      .where(
        and(
          eq(siBacklinks.targetEntityId, entity.id),
          gte(siBacklinks.firstSeenAt, since),
        ),
      );
    if (backlinks.length >= 3) {
      signals.push({
        type: "new_backlinks",
        magnitude: backlinks.length,
        observedAt: backlinks.at(-1)?.firstSeenAt ?? since,
        reason: `${String(backlinks.length)} nuovi backlink negli ultimi 7 giorni`,
      });
    }

    const domains = await db
      .select()
      .from(siReferringDomains)
      .where(
        and(
          eq(siReferringDomains.entityId, entity.id),
          gte(siReferringDomains.firstSeenAt, since),
        ),
      );
    if (domains.length >= 2) {
      signals.push({
        type: "new_referring_domains",
        magnitude: domains.length,
        observedAt: domains.at(-1)?.firstSeenAt ?? since,
        reason: `${String(domains.length)} nuovi domini referenti negli ultimi 7 giorni`,
      });
    }

    // Anchors repeated across several distinct domains is the signature of a
    // coordinated push rather than of organic coverage.
    const anchorCounts = new Map<string, Set<string>>();
    for (const backlink of backlinks) {
      if (!backlink.normalizedAnchor) continue;
      const set =
        anchorCounts.get(backlink.normalizedAnchor) ?? new Set<string>();
      set.add(backlink.normalizedSourceDomain);
      anchorCounts.set(backlink.normalizedAnchor, set);
    }
    const coordinated = [...anchorCounts.entries()].filter(
      ([, domainSet]) => domainSet.size >= 3,
    );
    if (coordinated.length > 0) {
      signals.push({
        type: "coordinated_anchors",
        magnitude: coordinated.length,
        observedAt: now.toISOString(),
        reason: `${String(coordinated.length)} anchor ripetute su almeno 3 domini distinti`,
      });
    }

    const ranks = await db
      .select()
      .from(siRankSnapshots)
      .where(
        and(
          eq(siRankSnapshots.entityId, entity.id),
          gte(siRankSnapshots.createdAt, since),
        ),
      );
    const gains = ranks.filter(
      (row) => row.isFound && row.rankGroup !== null && row.rankGroup <= 10,
    );
    if (gains.length >= 3) {
      signals.push({
        type: "ranking_gains",
        magnitude: gains.length,
        observedAt: gains.at(-1)?.createdAt ?? since,
        reason: `${String(gains.length)} posizionamenti in top 10 nel periodo`,
      });
    }

    // Mentions reach the graph, not the SEO tables, so they are counted there.
    const mentionEvents = await db
      .select()
      .from(siTimelineEvents)
      .where(
        and(
          eq(siTimelineEvents.eventType, "mention"),
          gte(siTimelineEvents.occurredAt, since),
        ),
      );
    if (mentionEvents.length >= 5) {
      signals.push({
        type: "mention_surge",
        magnitude: mentionEvents.length,
        observedAt: mentionEvents.at(-1)?.occurredAt ?? since,
        reason: `${String(mentionEvents.length)} mention registrate negli ultimi 7 giorni`,
      });
    }

    const candidate = detectCampaign({
      subjectLabel: entity.displayName,
      subjectEntityId: entity.id,
      subjectIsCompetitor: entity.entityType !== "primary",
      signals,
      now,
    });
    if (!candidate) continue;

    const campaignId = await store.saveCampaign(candidate, { now });
    if (!campaignId) continue;
    detected += 1;
    for (const signal of candidate.signals) {
      await graph.recordEvidence({
        subjectType: "campaign",
        subjectId: campaignId,
        evidenceType: signal.type,
        sourceSystem: "derived",
        observedAt: signal.observedAt,
        reason: signal.reason,
      });
    }
  }

  return detected;
}
