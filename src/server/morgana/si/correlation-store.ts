import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  siCampaignSignals,
  siCampaigns,
  siReputationFindings,
} from "@/db/schema";
import { newId, nowIso } from "./ids";
import type { CampaignCandidate, ReputationResult } from "./correlation";

/**
 * Morgana Search Intelligence — phase 4 campaign and reputation persistence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Same discipline as every earlier phase: UNIQUE dedupe keys, upserts, nothing
 * deleted. A campaign detected again on a later tick is the *same* campaign
 * with a later `last_activity_at`, not a second one — otherwise a week-long
 * push would produce seven identical entries in the analyst's queue.
 */

type CampaignRow = typeof siCampaigns.$inferSelect;
type CampaignSignalRow = typeof siCampaignSignals.$inferSelect;
type ReputationFindingRow = typeof siReputationFindings.$inferSelect;

/**
 * The campaign identity.
 *
 * Subject plus category plus ISO week: one push produces one campaign for as
 * long as it runs, and a genuinely new push the following week is genuinely a
 * new campaign.
 */
function campaignKey(candidate: CampaignCandidate, weekStamp: string): string {
  return [candidate.subjectLabel, candidate.category, weekStamp].join("|");
}

/** ISO-week stamp, used so a campaign spans the week it belongs to. */
function isoWeek(date: Date): string {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${String(target.getUTCFullYear())}-W${String(week).padStart(2, "0")}`;
}

export async function saveCampaign(
  candidate: CampaignCandidate,
  options: { entityNodeIds?: readonly string[]; now?: Date } = {},
): Promise<string | null> {
  const now = options.now ?? new Date();
  const dedupeKey = campaignKey(candidate, isoWeek(now));
  const at = nowIso();

  await db
    .insert(siCampaigns)
    .values({
      id: newId("cm"),
      category: candidate.category,
      subjectEntityId: candidate.subjectEntityId,
      subjectLabel: candidate.subjectLabel,
      startAt: candidate.startAt,
      lastActivityAt: candidate.lastActivityAt,
      windowDays: candidate.windowDays,
      signalCount: candidate.signals.length,
      confidence: candidate.confidence,
      status: "candidate",
      entities: JSON.stringify(options.entityNodeIds ?? []),
      dedupeKey,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: siCampaigns.dedupeKey,
      set: {
        lastActivityAt: candidate.lastActivityAt,
        signalCount: candidate.signals.length,
        confidence: candidate.confidence,
        entities: JSON.stringify(options.entityNodeIds ?? []),
        updatedAt: at,
        // `status` is deliberately absent: an analyst who dismissed a campaign
        // must not have it silently reopened by the next detection pass.
      },
    });

  const rows = await db
    .select({ id: siCampaigns.id })
    .from(siCampaigns)
    .where(eq(siCampaigns.dedupeKey, dedupeKey))
    .limit(1);
  const campaignId = rows[0]?.id ?? null;
  if (!campaignId) return null;

  for (const signal of candidate.signals) {
    try {
      await db.insert(siCampaignSignals).values({
        id: newId("cs"),
        campaignId,
        signalType: signal.type,
        magnitude: signal.magnitude,
        observedAt: signal.observedAt,
        reason: signal.reason.slice(0, 400),
        family: candidate.families.find((family) => family) ?? "unknown",
        dedupeKey: `${campaignId}|${signal.type}|${signal.observedAt.slice(0, 10)}`,
        createdAt: at,
      });
    } catch {
      // Already recorded for this campaign/type/day.
    }
  }
  return campaignId;
}

export async function listCampaigns(
  options: {
    status?: CampaignRow["status"];
    since?: string;
    limit?: number;
  } = {},
): Promise<CampaignRow[]> {
  const conditions = [];
  if (options.status) conditions.push(eq(siCampaigns.status, options.status));
  if (options.since)
    conditions.push(gte(siCampaigns.lastActivityAt, options.since));
  return db
    .select()
    .from(siCampaigns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(siCampaigns.lastActivityAt))
    .limit(options.limit ?? 100);
}

export async function getCampaign(
  id: string,
): Promise<CampaignRow | undefined> {
  const rows = await db
    .select()
    .from(siCampaigns)
    .where(eq(siCampaigns.id, id))
    .limit(1);
  return rows[0];
}

export async function campaignSignals(
  campaignId: string,
): Promise<CampaignSignalRow[]> {
  return db
    .select()
    .from(siCampaignSignals)
    .where(eq(siCampaignSignals.campaignId, campaignId))
    .orderBy(siCampaignSignals.observedAt);
}

export async function updateCampaignStatus(
  id: string,
  patch: {
    status?: CampaignRow["status"];
    reviewedBy?: string | null;
    reviewNote?: string | null;
  },
): Promise<CampaignRow | undefined> {
  const at = nowIso();
  await db
    .update(siCampaigns)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.reviewedBy === undefined
        ? {}
        : { reviewedBy: patch.reviewedBy }),
      ...(patch.reviewNote === undefined
        ? {}
        : {
            reviewNote:
              patch.reviewNote === null
                ? null
                : patch.reviewNote.slice(0, 1000),
          }),
      reviewedAt: at,
      updatedAt: at,
    })
    .where(eq(siCampaigns.id, id));
  return getCampaign(id);
}

// --- reputation findings ----------------------------------------------------

export async function saveReputationFinding(
  result: ReputationResult,
  input: {
    subjectLabel: string;
    affectedEntities?: readonly string[];
    now?: Date;
  },
): Promise<string | null> {
  const now = input.now ?? new Date();
  const at = nowIso();
  // Subject + category + day: one finding per subject per day, however many
  // times the correlation pass runs.
  const dedupeKey = [
    input.subjectLabel,
    result.category,
    now.toISOString().slice(0, 10),
  ].join("|");

  await db
    .insert(siReputationFindings)
    .values({
      id: newId("rf"),
      category: result.category,
      severity: result.severity,
      confidence: result.confidence,
      signals: JSON.stringify(result.signals),
      affectedEntities: JSON.stringify(input.affectedEntities ?? []),
      subjectLabel: input.subjectLabel,
      independentFamilies: result.independentFamilies,
      channel: result.channel,
      deliveryStatus: "detected",
      firstSeenAt: at,
      lastSeenAt: at,
      status: "new",
      dedupeKey,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: siReputationFindings.dedupeKey,
      set: {
        // Severity may rise as more signals arrive during the day; the review
        // status is never touched, so an analyst's decision stands.
        severity: result.severity,
        confidence: result.confidence,
        signals: JSON.stringify(result.signals),
        independentFamilies: result.independentFamilies,
        channel: result.channel,
        lastSeenAt: at,
        updatedAt: at,
      },
    });

  const rows = await db
    .select({ id: siReputationFindings.id })
    .from(siReputationFindings)
    .where(eq(siReputationFindings.dedupeKey, dedupeKey))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function listReputationFindings(
  options: {
    status?: ReputationFindingRow["status"];
    severity?: ReputationFindingRow["severity"];
    limit?: number;
  } = {},
): Promise<ReputationFindingRow[]> {
  const conditions = [];
  if (options.status)
    conditions.push(eq(siReputationFindings.status, options.status));
  if (options.severity)
    conditions.push(eq(siReputationFindings.severity, options.severity));
  return db
    .select()
    .from(siReputationFindings)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(siReputationFindings.lastSeenAt))
    .limit(options.limit ?? 100);
}

export async function getReputationFinding(
  id: string,
): Promise<ReputationFindingRow | undefined> {
  const rows = await db
    .select()
    .from(siReputationFindings)
    .where(eq(siReputationFindings.id, id))
    .limit(1);
  return rows[0];
}

export async function updateReputationFinding(
  id: string,
  patch: {
    status?: ReputationFindingRow["status"];
    reviewedBy?: string | null;
    reviewNote?: string | null;
  },
): Promise<ReputationFindingRow | undefined> {
  const at = nowIso();
  await db
    .update(siReputationFindings)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.reviewedBy === undefined
        ? {}
        : { reviewedBy: patch.reviewedBy }),
      ...(patch.reviewNote === undefined
        ? {}
        : {
            reviewNote:
              patch.reviewNote === null
                ? null
                : patch.reviewNote.slice(0, 1000),
          }),
      reviewedAt: at,
      updatedAt: at,
    })
    .where(eq(siReputationFindings.id, id));
  return getReputationFinding(id);
}

/** Findings awaiting delivery, loudest first. */
export async function pendingReputationAlerts(
  limit = 25,
): Promise<ReputationFindingRow[]> {
  return db
    .select()
    .from(siReputationFindings)
    .where(
      and(
        eq(siReputationFindings.deliveryStatus, "detected"),
        sql`${siReputationFindings.channel} != 'none'`,
      ),
    )
    .orderBy(
      desc(siReputationFindings.severity),
      desc(siReputationFindings.lastSeenAt),
    )
    .limit(limit);
}

export async function markAlertsDelivered(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const at = nowIso();
  await db
    .update(siReputationFindings)
    .set({ deliveryStatus: "delivered", deliveredAt: at, updatedAt: at })
    .where(
      and(
        inArray(siReputationFindings.id, [...ids]),
        eq(siReputationFindings.deliveryStatus, "detected"),
      ),
    );
}

export async function markAlertsSuppressed(
  ids: readonly string[],
  reason: string,
): Promise<void> {
  if (ids.length === 0) return;
  const at = nowIso();
  await db
    .update(siReputationFindings)
    .set({
      deliveryStatus: "suppressed",
      suppressionReason: reason.slice(0, 300),
      updatedAt: at,
    })
    .where(
      and(
        inArray(siReputationFindings.id, [...ids]),
        eq(siReputationFindings.deliveryStatus, "detected"),
      ),
    );
}
