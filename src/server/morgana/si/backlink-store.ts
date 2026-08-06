import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  siBacklinkSnapshots,
  siBacklinks,
  siReferringDomains,
} from "@/db/schema";
import { newId, nowIso } from "./ids";

/**
 * Morgana Search Intelligence — phase 3 persistence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Same discipline as phases 1 and 2: every write that could be retried carries
 * a UNIQUE dedupe key, so replaying a collection pass is free and two
 * overlapping schedulers converge instead of duplicating.
 *
 * Nothing is ever deleted. A backlink that disappears becomes `status = 'lost'`
 * with a `lost_at`, which is what makes the history reconstructable and stops a
 * flapping provider from erasing evidence.
 */

type BacklinkRow = typeof siBacklinks.$inferSelect;
type BacklinkSnapshotRow = typeof siBacklinkSnapshots.$inferSelect;
type ReferringDomainRow = typeof siReferringDomains.$inferSelect;

interface UpsertBacklinkInput {
  targetEntityId: string;
  sourceUrl: string;
  normalizedSourceUrl: string;
  sourceDomain: string;
  normalizedSourceDomain: string;
  targetUrl: string;
  normalizedTargetUrl: string;
  anchorText: string | null;
  normalizedAnchor: string | null;
  linkType: string;
  isDofollow: boolean | null;
  domainRank: number | null;
  pageRank: number | null;
  spamScore: number | null;
  providerBacklinkId: string | null;
  provider: string;
  firstSeenAt: string;
  dedupeKey: string;
}

/**
 * Record observed backlinks.
 *
 * `onConflictDoUpdate` on the dedupe key means a re-observation refreshes
 * `last_seen_at` and revives a previously-lost link rather than inserting a
 * second row — a link that comes back is the same link.
 */
export async function upsertBacklinks(
  inputs: readonly UpsertBacklinkInput[],
): Promise<number> {
  const at = nowIso();
  let written = 0;
  for (const input of inputs) {
    await db
      .insert(siBacklinks)
      .values({
        id: newId("bl"),
        targetEntityId: input.targetEntityId,
        sourceUrl: input.sourceUrl,
        normalizedSourceUrl: input.normalizedSourceUrl,
        sourceDomain: input.sourceDomain,
        normalizedSourceDomain: input.normalizedSourceDomain,
        targetUrl: input.targetUrl,
        normalizedTargetUrl: input.normalizedTargetUrl,
        anchorText: input.anchorText,
        normalizedAnchor: input.normalizedAnchor,
        linkType: input.linkType,
        isDofollow: input.isDofollow,
        isNofollow: input.isDofollow === null ? null : !input.isDofollow,
        firstSeenAt: input.firstSeenAt,
        lastSeenAt: at,
        lostAt: null,
        status: "active",
        provider: input.provider,
        providerBacklinkId: input.providerBacklinkId,
        domainRank: input.domainRank,
        pageRank: input.pageRank,
        spamScore: input.spamScore,
        dedupeKey: input.dedupeKey,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: siBacklinks.dedupeKey,
        set: {
          lastSeenAt: at,
          status: "active",
          lostAt: null,
          domainRank: input.domainRank,
          pageRank: input.pageRank,
          spamScore: input.spamScore,
          isDofollow: input.isDofollow,
          updatedAt: at,
        },
      });
    written += 1;
  }
  return written;
}

/** Active backlinks for an entity, newest observation first. */
export async function activeBacklinks(
  entityId: string,
  limit = 1000,
): Promise<BacklinkRow[]> {
  return db
    .select()
    .from(siBacklinks)
    .where(
      and(
        eq(siBacklinks.targetEntityId, entityId),
        eq(siBacklinks.status, "active"),
      ),
    )
    .orderBy(desc(siBacklinks.lastSeenAt))
    .limit(limit);
}

export async function backlinksByStatus(
  entityId: string,
  status: "active" | "lost" | "unknown",
  limit = 500,
): Promise<BacklinkRow[]> {
  return db
    .select()
    .from(siBacklinks)
    .where(
      and(
        eq(siBacklinks.targetEntityId, entityId),
        eq(siBacklinks.status, status),
      ),
    )
    .orderBy(desc(siBacklinks.lastSeenAt))
    .limit(limit);
}

/** Backlinks first seen since a date — the "new" list, derived from our data. */
export async function backlinksFirstSeenSince(
  entityId: string,
  since: string,
  limit = 500,
): Promise<BacklinkRow[]> {
  return db
    .select()
    .from(siBacklinks)
    .where(
      and(
        eq(siBacklinks.targetEntityId, entityId),
        gte(siBacklinks.firstSeenAt, since),
      ),
    )
    .orderBy(desc(siBacklinks.firstSeenAt))
    .limit(limit);
}

/**
 * Mark links lost.
 *
 * Callers pass only confirmed losses — the diff layer refuses to produce any
 * from a partial snapshot, and requires two consecutive absences.
 */
export async function markBacklinksLost(
  dedupeKeys: readonly string[],
): Promise<number> {
  if (dedupeKeys.length === 0) return 0;
  const at = nowIso();
  await db
    .update(siBacklinks)
    .set({ status: "lost", lostAt: at, updatedAt: at })
    .where(inArray(siBacklinks.dedupeKey, [...dedupeKeys]));
  return dedupeKeys.length;
}

interface SnapshotInput {
  entityId: string;
  snapshotDate: string;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  dofollowCount: number | null;
  nofollowCount: number | null;
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
  comparisonStatus: "complete" | "partial" | "not_comparable";
  comparisonReason: string | null;
  backlinksProcessed: number;
  domainsProcessed: number;
  provider: string;
  estimatedCostMicros: number;
  actualCostMicros: number;
  /**
   * What a real collection knows about itself.
   *
   * Without these the row defaults to `source: "fixture"` and a null sample —
   * which is how a live snapshot ended up labelled as a fixture in production
   * while holding 1611 real backlinks. A row that misreports its own
   * provenance is worse than a missing row.
   */
  source?: "dataforseo" | "fixture";
  snapshotStatus?: "complete" | "partial" | "no_data";
  snapshotStatusReason?: string | null;
  sampleLimit?: number | null;
  datasetCoverage?: number | null;
  reportedBacklinkTotal?: number | null;
  reportedReferringDomainTotal?: number | null;
  datasetSignature?: string | null;
  costStatus?: string | null;
  providerReportedCostMicros?: number | null;
}

export async function saveSnapshot(input: SnapshotInput): Promise<void> {
  const at = nowIso();
  await db
    .insert(siBacklinkSnapshots)
    .values({
      id: newId("bs"),
      entityId: input.entityId,
      snapshotAt: at,
      snapshotDate: input.snapshotDate,
      source: input.source ?? "fixture",
      snapshotStatus: input.snapshotStatus ?? "complete",
      snapshotStatusReason: input.snapshotStatusReason ?? null,
      sampleLimit: input.sampleLimit ?? null,
      datasetCoverage: input.datasetCoverage ?? null,
      reportedBacklinkTotal: input.reportedBacklinkTotal ?? null,
      reportedReferringDomainTotal: input.reportedReferringDomainTotal ?? null,
      datasetSignature: input.datasetSignature ?? null,
      costStatus: input.costStatus ?? null,
      providerReportedCostMicros: input.providerReportedCostMicros ?? null,
      backlinkCount: input.backlinkCount,
      referringDomainCount: input.referringDomainCount,
      dofollowCount: input.dofollowCount,
      nofollowCount: input.nofollowCount,
      newBacklinks: input.newBacklinks,
      lostBacklinks: input.lostBacklinks,
      newReferringDomains: input.newReferringDomains,
      lostReferringDomains: input.lostReferringDomains,
      comparisonStatus: input.comparisonStatus,
      comparisonReason: input.comparisonReason,
      backlinksProcessed: input.backlinksProcessed,
      domainsProcessed: input.domainsProcessed,
      provider: input.provider,
      estimatedCostMicros: input.estimatedCostMicros,
      actualCostMicros: input.actualCostMicros,
      dedupeKey: `${input.entityId}|${input.snapshotDate}`,
      createdAt: at,
    })
    .onConflictDoUpdate({
      target: siBacklinkSnapshots.dedupeKey,
      set: {
        snapshotAt: at,
        backlinkCount: input.backlinkCount,
        referringDomainCount: input.referringDomainCount,
        dofollowCount: input.dofollowCount,
        nofollowCount: input.nofollowCount,
        newBacklinks: input.newBacklinks,
        lostBacklinks: input.lostBacklinks,
        newReferringDomains: input.newReferringDomains,
        lostReferringDomains: input.lostReferringDomains,
        comparisonStatus: input.comparisonStatus,
        comparisonReason: input.comparisonReason,
        backlinksProcessed: input.backlinksProcessed,
        domainsProcessed: input.domainsProcessed,
      },
    });
}

export async function snapshotHistory(
  entityId: string,
  since: string,
): Promise<BacklinkSnapshotRow[]> {
  return db
    .select()
    .from(siBacklinkSnapshots)
    .where(
      and(
        eq(siBacklinkSnapshots.entityId, entityId),
        gte(siBacklinkSnapshots.snapshotDate, since),
      ),
    )
    .orderBy(siBacklinkSnapshots.snapshotDate);
}

export async function latestSnapshot(
  entityId: string,
): Promise<BacklinkSnapshotRow | undefined> {
  const rows = await db
    .select()
    .from(siBacklinkSnapshots)
    .where(eq(siBacklinkSnapshots.entityId, entityId))
    .orderBy(desc(siBacklinkSnapshots.snapshotDate))
    .limit(1);
  return rows[0];
}

export interface UpsertReferringDomainInput {
  entityId: string;
  domain: string;
  normalizedDomain: string;
  backlinkCount: number | null;
  targetPageCount: number | null;
  domainRank: number | null;
  spamScore: number | null;
  country: string | null;
  tld: string | null;
  firstSeenAt: string;
  riskScore: number | null;
  riskClassification: "low" | "review" | "suspicious" | "high_risk" | null;
  riskReasons: string | null;
}

export async function upsertReferringDomains(
  inputs: readonly UpsertReferringDomainInput[],
): Promise<number> {
  const at = nowIso();
  for (const input of inputs) {
    await db
      .insert(siReferringDomains)
      .values({
        id: newId("rd"),
        entityId: input.entityId,
        domain: input.domain,
        normalizedDomain: input.normalizedDomain,
        firstSeenAt: input.firstSeenAt,
        lastSeenAt: at,
        lostAt: null,
        backlinkCount: input.backlinkCount,
        targetPageCount: input.targetPageCount,
        domainRank: input.domainRank,
        spamScore: input.spamScore,
        country: input.country,
        tld: input.tld,
        status: "active",
        riskClassification: input.riskClassification,
        riskScore: input.riskScore,
        riskReasons: input.riskReasons,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [
          siReferringDomains.entityId,
          siReferringDomains.normalizedDomain,
        ],
        set: {
          lastSeenAt: at,
          status: "active",
          lostAt: null,
          backlinkCount: input.backlinkCount,
          targetPageCount: input.targetPageCount,
          domainRank: input.domainRank,
          spamScore: input.spamScore,
          riskScore: input.riskScore,
          riskClassification: input.riskClassification,
          riskReasons: input.riskReasons,
          updatedAt: at,
        },
      });
  }
  return inputs.length;
}

export async function listReferringDomains(
  entityId: string,
  options: { status?: "active" | "lost"; limit?: number } = {},
): Promise<ReferringDomainRow[]> {
  const where = options.status
    ? and(
        eq(siReferringDomains.entityId, entityId),
        eq(siReferringDomains.status, options.status),
      )
    : eq(siReferringDomains.entityId, entityId);
  return db
    .select()
    .from(siReferringDomains)
    .where(where)
    .orderBy(desc(siReferringDomains.domainRank))
    .limit(options.limit ?? 250);
}

export async function markReferringDomainsLost(
  entityId: string,
  normalizedDomains: readonly string[],
): Promise<number> {
  if (normalizedDomains.length === 0) return 0;
  const at = nowIso();
  await db
    .update(siReferringDomains)
    .set({ status: "lost", lostAt: at, updatedAt: at })
    .where(
      and(
        eq(siReferringDomains.entityId, entityId),
        inArray(siReferringDomains.normalizedDomain, [...normalizedDomains]),
      ),
    );
  return normalizedDomains.length;
}
