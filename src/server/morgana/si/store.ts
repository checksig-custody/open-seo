import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import {
  domainSnapshotKeywords,
  domainSnapshotPages,
  domainSnapshots,
  searchEntities,
} from "@/db/schema";
import { normalizeEntityDomain, normalizePageUrl } from "./domains";
import type { SnapshotPoint } from "./metrics";
import { newId, nowIso } from "./ids";
import { chunkForD1 } from "./d1-chunk";

/**
 * Morgana Search Intelligence — persistence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * All D1 access for Search Intelligence lives here so the service layer stays
 * testable and the SQL is reviewable in one place. Writes are idempotent by
 * construction: every insert that could be retried carries a natural key with a
 * UNIQUE index behind it, and uses `onConflictDoNothing`/`onConflictDoUpdate`
 * rather than a read-then-write race.
 */

type EntityType = "primary" | "competitor" | "watch";
type Priority = "high" | "normal" | "low";

export type SearchEntityRow = typeof searchEntities.$inferSelect;
export type SnapshotKeywordRow = typeof domainSnapshotKeywords.$inferSelect;
export type SnapshotPageRow = typeof domainSnapshotPages.$inferSelect;

interface CreateEntityInput {
  displayName: string;
  domain: string;
  entityType: EntityType;
  priority?: Priority;
  includeSubdomains?: boolean;
  locationCode?: number;
  languageCode?: string;
  refreshIntervalHours?: number;
  backlinkIntervalHours?: number;
}

/** UTC date bucket. Snapshots are keyed by day, not by instant. */
export function snapshotDateFor(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// --- entities ---------------------------------------------------------------

export async function listEntities(
  options: {
    includeDisabled?: boolean;
  } = {},
): Promise<SearchEntityRow[]> {
  const rows = await db
    .select()
    .from(searchEntities)
    .orderBy(searchEntities.entityType, searchEntities.displayName);
  const all = rows;
  return options.includeDisabled ? all : all.filter((row) => row.enabled);
}

export async function getEntity(id: string): Promise<SearchEntityRow | null> {
  const rows = await db
    .select()
    .from(searchEntities)
    .where(eq(searchEntities.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createEntity(
  input: CreateEntityInput,
): Promise<SearchEntityRow> {
  // Validation throws DomainValidationError, which the API maps to a 400.
  const domain = normalizeEntityDomain(input.domain, {
    includeSubdomains: input.includeSubdomains ?? false,
  });
  const timestamp = nowIso();
  const row = {
    id: newId("se"),
    displayName: input.displayName.trim().slice(0, 200),
    canonicalDomain: domain.display,
    normalizedDomain: domain.normalized,
    entityType: input.entityType,
    enabled: true,
    priority: input.priority ?? "normal",
    includeSubdomains: input.includeSubdomains ?? false,
    locationCode: input.locationCode ?? 2380,
    languageCode: input.languageCode ?? "it",
    refreshIntervalHours: input.refreshIntervalHours ?? 24,
    backlinkIntervalHours: input.backlinkIntervalHours ?? 168,
    lastRefreshedAt: null,
    lastBacklinkRefreshedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    disabledAt: null,
  };
  await db.insert(searchEntities).values(row);
  return row as SearchEntityRow;
}

interface UpdateEntityInput {
  displayName?: string;
  priority?: Priority;
  includeSubdomains?: boolean;
  locationCode?: number;
  languageCode?: string;
  refreshIntervalHours?: number;
  backlinkIntervalHours?: number;
  enabled?: boolean;
}

export async function updateEntity(
  id: string,
  input: UpdateEntityInput,
): Promise<SearchEntityRow | null> {
  const existing = await getEntity(id);
  if (!existing) return null;
  const timestamp = nowIso();
  const patch: Record<string, unknown> = { updatedAt: timestamp };
  if (input.displayName !== undefined)
    patch.displayName = input.displayName.trim().slice(0, 200);
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.includeSubdomains !== undefined)
    patch.includeSubdomains = input.includeSubdomains;
  if (input.locationCode !== undefined) patch.locationCode = input.locationCode;
  if (input.languageCode !== undefined) patch.languageCode = input.languageCode;
  if (input.refreshIntervalHours !== undefined)
    patch.refreshIntervalHours = input.refreshIntervalHours;
  if (input.backlinkIntervalHours !== undefined)
    patch.backlinkIntervalHours = input.backlinkIntervalHours;
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
    // Disabling records WHEN, and never deletes: history outlives the entity's
    // active life, which is the whole point of keeping snapshots.
    patch.disabledAt = input.enabled ? null : timestamp;
  }
  await db.update(searchEntities).set(patch).where(eq(searchEntities.id, id));
  return getEntity(id);
}

// --- snapshots --------------------------------------------------------------

interface SnapshotMetrics {
  organicTrafficEstimate: number | null;
  organicKeywordCount: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  rankSignal: number | null;
}

interface KeywordRow {
  keyword: string;
  rankGroup: number | null;
  rankAbsolute: number | null;
  searchVolume: number | null;
  estimatedTraffic: number | null;
  cpc: number | null;
  keywordDifficulty: number | null;
  searchIntent: string | null;
  rankingUrl: string | null;
  serpUpdatedAt?: string | null;
}

interface PageRow {
  url: string;
  estimatedTraffic: number | null;
  keywordCount: number | null;
  topKeyword: string | null;
  topKeywordPosition: number | null;
  pageTitle: string | null;
  lastSeenAt?: string | null;
}

interface PersistSnapshotInput {
  entity: SearchEntityRow;
  snapshotDate: string;
  metrics: SnapshotMetrics;
  keywords: KeywordRow[];
  pages: PageRow[];
  source: "dataforseo" | "fixture";
  providerRequestId?: string | null;
  estimatedCostMicros: number;
  actualCostMicros: number;
  /** Set only by a forced refresh; see the dedupe branch in persistSnapshot. */
  replaceExisting?: boolean;
}

interface PersistSnapshotResult {
  snapshotId: string;
  created: boolean;
  /** True when a forced refresh overwrote the day existing snapshot. */
  replaced?: boolean;
}

/** `entity|location|language|date` — the natural key for one day's snapshot. */
export function snapshotDedupeKey(
  entityId: string,
  locationCode: number,
  languageCode: string,
  snapshotDate: string,
): string {
  return `${entityId}|${String(locationCode)}|${languageCode}|${snapshotDate}`;
}

/**
 * Write a snapshot and its children, at most once per entity/market/day.
 *
 * Idempotency is enforced by the database, not by a prior read: two concurrent
 * refreshes both attempt the insert and exactly one wins, because `dedupe_key`
 * is UNIQUE. The loser returns the winner's id rather than an error, so a racing
 * manual refresh sees the same snapshot the scheduler just produced.
 */
export async function persistSnapshot(
  input: PersistSnapshotInput,
): Promise<PersistSnapshotResult> {
  const dedupeKey = snapshotDedupeKey(
    input.entity.id,
    input.entity.locationCode,
    input.entity.languageCode,
    input.snapshotDate,
  );
  const existing = await db
    .select({ id: domainSnapshots.id })
    .from(domainSnapshots)
    .where(eq(domainSnapshots.dedupeKey, dedupeKey))
    .limit(1);
  if (existing[0]) {
    // A forced refresh has ALREADY PAID for a fresh collection. Returning the
    // stale row here would throw that result away and bill for nothing, which
    // is exactly what happened on the first forced run: the provider was called
    // and charged, and the snapshot on screen stayed the old one.
    //
    // Anything other than a forced refresh keeps the original behaviour — the
    // UNIQUE key is what makes a duplicated tick free rather than billable.
    if (!input.replaceExisting) {
      return { snapshotId: existing[0].id, created: false };
    }
    await replaceSnapshot(existing[0].id, input);
    return { snapshotId: existing[0].id, created: false, replaced: true };
  }

  const snapshotId = newId("ds");
  const timestamp = nowIso();
  try {
    await db.insert(domainSnapshots).values({
      id: snapshotId,
      entityId: input.entity.id,
      organicTrafficEstimate: input.metrics.organicTrafficEstimate,
      organicKeywordCount: input.metrics.organicKeywordCount,
      backlinkCount: input.metrics.backlinkCount,
      referringDomainCount: input.metrics.referringDomainCount,
      rankSignal: input.metrics.rankSignal,
      locationCode: input.entity.locationCode,
      languageCode: input.entity.languageCode,
      source: input.source,
      providerRequestId: input.providerRequestId ?? null,
      fetchedAt: timestamp,
      snapshotDate: input.snapshotDate,
      estimatedCostMicros: input.estimatedCostMicros,
      actualCostMicros: input.actualCostMicros,
      dedupeKey,
      createdAt: timestamp,
    });
  } catch (error) {
    // Lost the race: another writer inserted the same dedupe key between the
    // read above and this insert. Return theirs.
    const winner = await db
      .select({ id: domainSnapshots.id })
      .from(domainSnapshots)
      .where(eq(domainSnapshots.dedupeKey, dedupeKey))
      .limit(1);
    if (winner[0]) return { snapshotId: winner[0].id, created: false };
    throw error;
  }

  await insertSnapshotKeywords(snapshotId, input.keywords);
  await insertSnapshotPages(snapshotId, input.pages, timestamp);

  return { snapshotId, created: true };
}

/**
 * Snapshot children, written in statement-sized batches.
 *
 * 13 columns per keyword row against D1's 100-parameter ceiling, so a single
 * insert of the 100 keywords this collector asks for would bind 1300 and be
 * refused. Exactly the defect the phase-5 frontier hit; `chunkForD1` derives
 * the batch from the column count so it cannot drift when a column is added.
 */
async function insertSnapshotKeywords(
  snapshotId: string,
  keywords: readonly KeywordRow[],
): Promise<void> {
  let position = 0;
  for (const chunk of chunkForD1(keywords, 13)) {
    await db.insert(domainSnapshotKeywords).values(
      chunk.map((kw) => {
        position += 1;
        return {
          id: newId("dk"),
          snapshotId,
          keyword: kw.keyword.slice(0, 500),
          rankGroup: kw.rankGroup,
          rankAbsolute: kw.rankAbsolute,
          searchVolume: kw.searchVolume,
          estimatedTraffic: kw.estimatedTraffic,
          cpc: kw.cpc,
          keywordDifficulty: kw.keywordDifficulty,
          searchIntent: kw.searchIntent,
          rankingUrl: kw.rankingUrl?.slice(0, 2000) ?? null,
          serpUpdatedAt: kw.serpUpdatedAt ?? null,
          position,
        };
      }),
    );
  }
}

/** 11 columns per row; same reasoning as the keywords above. */
async function insertSnapshotPages(
  snapshotId: string,
  pages: readonly PageRow[],
  timestamp: string,
): Promise<void> {
  let position = 0;
  for (const chunk of chunkForD1(pages, 11)) {
    await db.insert(domainSnapshotPages).values(
      chunk.map((page) => {
        position += 1;
        return {
          id: newId("dp"),
          snapshotId,
          url: page.url.slice(0, 2000),
          normalizedUrl: normalizePageUrl(page.url).slice(0, 2000),
          estimatedTraffic: page.estimatedTraffic,
          keywordCount: page.keywordCount,
          topKeyword: page.topKeyword?.slice(0, 500) ?? null,
          topKeywordPosition: page.topKeywordPosition,
          pageTitle: page.pageTitle?.slice(0, 500) ?? null,
          lastSeenAt: page.lastSeenAt ?? timestamp,
          position,
        };
      }),
    );
  }
}

/**
 * Overwrite an existing snapshot with a freshly collected one.
 *
 * Only ever reached from a FORCED refresh, which has already paid for the
 * collection. The children are deleted and rewritten rather than merged: a
 * merge would leave yesterday's keywords sitting beside today's with no way to
 * tell them apart.
 */
async function replaceSnapshot(
  snapshotId: string,
  input: PersistSnapshotInput,
): Promise<void> {
  const timestamp = nowIso();
  await db
    .update(domainSnapshots)
    .set({
      organicTrafficEstimate: input.metrics.organicTrafficEstimate,
      organicKeywordCount: input.metrics.organicKeywordCount,
      backlinkCount: input.metrics.backlinkCount,
      referringDomainCount: input.metrics.referringDomainCount,
      rankSignal: input.metrics.rankSignal,
      source: input.source,
      providerRequestId: input.providerRequestId ?? null,
      fetchedAt: timestamp,
      estimatedCostMicros: input.estimatedCostMicros,
      actualCostMicros: input.actualCostMicros,
    })
    .where(eq(domainSnapshots.id, snapshotId));
  await db
    .delete(domainSnapshotKeywords)
    .where(eq(domainSnapshotKeywords.snapshotId, snapshotId));
  await db
    .delete(domainSnapshotPages)
    .where(eq(domainSnapshotPages.snapshotId, snapshotId));
  await insertSnapshotKeywords(snapshotId, input.keywords);
  await insertSnapshotPages(snapshotId, input.pages, timestamp);
}

export async function latestSnapshot(entityId: string) {
  const rows = await db
    .select()
    .from(domainSnapshots)
    .where(eq(domainSnapshots.entityId, entityId))
    .orderBy(desc(domainSnapshots.snapshotDate))
    .limit(1);
  return rows[0] ?? null;
}

export async function snapshotHistory(
  entityId: string,
  sinceDate: string,
): Promise<SnapshotPoint[]> {
  const rows = await db
    .select({
      snapshotDate: domainSnapshots.snapshotDate,
      organicTrafficEstimate: domainSnapshots.organicTrafficEstimate,
      organicKeywordCount: domainSnapshots.organicKeywordCount,
      backlinkCount: domainSnapshots.backlinkCount,
      referringDomainCount: domainSnapshots.referringDomainCount,
    })
    .from(domainSnapshots)
    .where(
      and(
        eq(domainSnapshots.entityId, entityId),
        gte(domainSnapshots.snapshotDate, sinceDate),
      ),
    )
    .orderBy(domainSnapshots.snapshotDate);
  return rows as SnapshotPoint[];
}

export async function snapshotKeywords(snapshotId: string, limit = 100) {
  return db
    .select()
    .from(domainSnapshotKeywords)
    .where(eq(domainSnapshotKeywords.snapshotId, snapshotId))
    .orderBy(domainSnapshotKeywords.position)
    .limit(limit);
}

export async function snapshotPages(snapshotId: string, limit = 100) {
  return db
    .select()
    .from(domainSnapshotPages)
    .where(eq(domainSnapshotPages.snapshotId, snapshotId))
    .orderBy(domainSnapshotPages.position)
    .limit(limit);
}
