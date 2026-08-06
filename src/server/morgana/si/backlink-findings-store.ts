import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { siBacklinkEvents, siBacklinkGapSnapshots } from "@/db/schema";
import { newId, nowIso } from "./ids";

/**
 * Morgana Search Intelligence — phase 3 gap snapshots, events and findings.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Split from backlink-store to stay inside the 400-line module limit. These
 * three are *derived* from observed backlinks and are recomputed as a unit,
 * whereas the store they came from records what the provider actually saw.
 */

export type BacklinkEventRow = typeof siBacklinkEvents.$inferSelect;

// --- gap --------------------------------------------------------------------

interface GapSnapshotInput {
  normalizedDomain: string;
  domain: string;
  snapshotDate: string;
  category:
    | "shared"
    | "primary_only"
    | "competitor_only"
    | "multi_competitor_only"
    | "new_opportunity";
  competitorEntityIds: readonly string[];
  linksPrimary: boolean;
  competitorCount: number;
  domainRank: number | null;
  spamScore: number | null;
  riskClassification: "low" | "review" | "suspicious" | "high_risk" | null;
  opportunityScore: number | null;
}

export async function saveGapSnapshots(
  inputs: readonly GapSnapshotInput[],
): Promise<number> {
  const at = nowIso();
  for (const input of inputs) {
    await db
      .insert(siBacklinkGapSnapshots)
      .values({
        id: newId("bg"),
        normalizedDomain: input.normalizedDomain,
        domain: input.domain,
        snapshotDate: input.snapshotDate,
        category: input.category,
        competitorEntityIds: JSON.stringify(input.competitorEntityIds),
        linksPrimary: input.linksPrimary,
        competitorCount: input.competitorCount,
        domainRank: input.domainRank,
        spamScore: input.spamScore,
        riskClassification: input.riskClassification,
        opportunityScore: input.opportunityScore,
        createdAt: at,
      })
      .onConflictDoUpdate({
        target: [
          siBacklinkGapSnapshots.normalizedDomain,
          siBacklinkGapSnapshots.snapshotDate,
        ],
        set: {
          category: input.category,
          competitorEntityIds: JSON.stringify(input.competitorEntityIds),
          linksPrimary: input.linksPrimary,
          competitorCount: input.competitorCount,
          domainRank: input.domainRank,
          spamScore: input.spamScore,
          riskClassification: input.riskClassification,
          opportunityScore: input.opportunityScore,
        },
      });
  }
  return inputs.length;
}

export async function latestGap(snapshotDate: string, limit = 500) {
  return db
    .select()
    .from(siBacklinkGapSnapshots)
    .where(eq(siBacklinkGapSnapshots.snapshotDate, snapshotDate))
    .orderBy(desc(siBacklinkGapSnapshots.opportunityScore))
    .limit(limit);
}

export async function mostRecentGapDate(): Promise<string | undefined> {
  const rows = await db
    .select({ snapshotDate: siBacklinkGapSnapshots.snapshotDate })
    .from(siBacklinkGapSnapshots)
    .orderBy(desc(siBacklinkGapSnapshots.snapshotDate))
    .limit(1);
  return rows[0]?.snapshotDate;
}

// --- events and findings ----------------------------------------------------

export interface BacklinkEventInput {
  eventType: BacklinkEventRow["eventType"];
  entityId: string;
  backlinkId?: string | null;
  referringDomainId?: string | null;
  subjectDomain: string | null;
  severity: BacklinkEventRow["severity"];
  channel: BacklinkEventRow["channel"];
  riskScore?: number | null;
  riskClassification?: "low" | "review" | "suspicious" | "high_risk" | null;
  reasons?: unknown;
  brandProtectionSignals?: unknown;
  brandProtectionStatus?: string;
  dedupeKey: string;
}

/**
 * Record events, letting the UNIQUE key act as the cooldown.
 *
 * The dedupe key includes the day, so one domain produces at most one ordinary
 * event per 24 hours no matter how many links it adds — the caller builds the
 * key, this just refuses the duplicate.
 */
export async function saveBacklinkEvents(
  inputs: readonly BacklinkEventInput[],
): Promise<BacklinkEventInput[]> {
  const at = nowIso();
  const stored: BacklinkEventInput[] = [];
  for (const input of inputs) {
    try {
      await db.insert(siBacklinkEvents).values({
        id: newId("be"),
        eventType: input.eventType,
        entityId: input.entityId,
        backlinkId: input.backlinkId ?? null,
        referringDomainId: input.referringDomainId ?? null,
        subjectDomain: input.subjectDomain,
        severity: input.severity,
        channel: input.channel,
        status: "detected",
        riskScore: input.riskScore ?? null,
        riskClassification: input.riskClassification ?? null,
        reasons:
          input.reasons === undefined ? null : JSON.stringify(input.reasons),
        brandProtectionSignals:
          input.brandProtectionSignals === undefined
            ? null
            : JSON.stringify(input.brandProtectionSignals),
        brandProtectionStatus: input.brandProtectionStatus ?? "no_known_signal",
        detectedAt: at,
        dedupeKey: input.dedupeKey,
        createdAt: at,
        updatedAt: at,
      });
      stored.push(input);
    } catch {
      // Already recorded for this domain/type/day. That is the cooldown.
    }
  }
  return stored;
}

export async function pendingBacklinkEvents(
  limit = 50,
): Promise<BacklinkEventRow[]> {
  return db
    .select()
    .from(siBacklinkEvents)
    .where(eq(siBacklinkEvents.status, "detected"))
    .orderBy(desc(siBacklinkEvents.riskScore), siBacklinkEvents.detectedAt)
    .limit(limit);
}

export async function markEventsDelivered(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const at = nowIso();
  await db
    .update(siBacklinkEvents)
    .set({ status: "delivered", deliveredAt: at, updatedAt: at })
    .where(
      and(
        inArray(siBacklinkEvents.id, [...ids]),
        eq(siBacklinkEvents.status, "detected"),
      ),
    );
}

export async function listFindings(options: {
  reviewStatus?: BacklinkEventRow["reviewStatus"];
  minRisk?: number;
  limit?: number;
}): Promise<BacklinkEventRow[]> {
  const conditions = [
    inArray(siBacklinkEvents.eventType, [
      "suspicious_link",
      "possible_impersonation",
    ]),
  ];
  if (options.reviewStatus)
    conditions.push(eq(siBacklinkEvents.reviewStatus, options.reviewStatus));
  if (typeof options.minRisk === "number") {
    conditions.push(gte(siBacklinkEvents.riskScore, options.minRisk));
  }
  return db
    .select()
    .from(siBacklinkEvents)
    .where(and(...conditions))
    .orderBy(
      desc(siBacklinkEvents.riskScore),
      desc(siBacklinkEvents.detectedAt),
    )
    .limit(options.limit ?? 200);
}

export async function getFinding(
  id: string,
): Promise<BacklinkEventRow | undefined> {
  const rows = await db
    .select()
    .from(siBacklinkEvents)
    .where(eq(siBacklinkEvents.id, id))
    .limit(1);
  return rows[0];
}

/**
 * Update the review state of one finding.
 *
 * Notes are bounded here rather than only at the HTTP layer: this is the last
 * place before the database, and an unbounded analyst note is a storage
 * problem regardless of which caller wrote it.
 */
export async function updateFindingReview(
  id: string,
  patch: {
    reviewStatus?: BacklinkEventRow["reviewStatus"];
    reviewedBy?: string | null;
    reviewNote?: string | null;
  },
): Promise<BacklinkEventRow | undefined> {
  const at = nowIso();
  await db
    .update(siBacklinkEvents)
    .set({
      ...(patch.reviewStatus ? { reviewStatus: patch.reviewStatus } : {}),
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
    .where(eq(siBacklinkEvents.id, id));
  return getFinding(id);
}

/** Counts used by the overview panel, in one round trip. */
export async function findingCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({
      reviewStatus: siBacklinkEvents.reviewStatus,
      total: sql<number>`count(*)`,
    })
    .from(siBacklinkEvents)
    .where(
      inArray(siBacklinkEvents.eventType, [
        "suspicious_link",
        "possible_impersonation",
      ]),
    )
    .groupBy(siBacklinkEvents.reviewStatus);
  return Object.fromEntries(
    rows.map((row) => [row.reviewStatus, Number(row.total)]),
  );
}
