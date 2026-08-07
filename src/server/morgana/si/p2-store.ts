import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { keywordClusters, siRankSnapshots, trackedKeywords } from "@/db/schema";
import { newId, nowIso } from "./ids";
import {
  classifyKeyword,
  DEFAULT_CLUSTERS,
  frequencyHoursFor,
  isValidKeyword,
  normalizeKeyword,
  type Priority,
} from "./keywords";
import { normalizePageUrl } from "./domains";
import type { Observation } from "./gap";

/**
 * Morgana Search Intelligence — phase 2 persistence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Same discipline as phase 1: every insert that could be retried carries a
 * natural key behind a UNIQUE index, so a duplicated job, a retry and a manual
 * trigger collapse into one row instead of one billable call each.
 */

type ClusterRow = typeof keywordClusters.$inferSelect;
type TrackedKeywordRow = typeof trackedKeywords.$inferSelect;
type RankSnapshotRow = typeof siRankSnapshots.$inferSelect;

class KeywordValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "KeywordValidationError";
  }
}

const today = (now: Date = new Date()) => now.toISOString().slice(0, 10);

// --- clusters ---------------------------------------------------------------

export async function listClusters(): Promise<ClusterRow[]> {
  return db.select().from(keywordClusters).orderBy(keywordClusters.name);
}

export async function ensureDefaultClusters(): Promise<number> {
  const existing = await listClusters();
  const known = new Set(existing.map((c) => c.slug));
  const missing = DEFAULT_CLUSTERS.filter((c) => !known.has(c.slug));
  if (missing.length === 0) return 0;
  await db.insert(keywordClusters).values(
    missing.map((c) => ({
      id: newId("kc"),
      name: c.name,
      slug: c.slug,
      description: null,
      weight: c.weight,
      enabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })),
  );
  return missing.length;
}

export async function createCluster(input: {
  name: string;
  slug: string;
  weight?: number;
  description?: string | null;
}): Promise<ClusterRow> {
  const row = {
    id: newId("kc"),
    name: input.name.trim().slice(0, 120),
    slug: input.slug.trim().toLowerCase().slice(0, 80),
    description: input.description ?? null,
    weight: input.weight ?? 1,
    enabled: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await db.insert(keywordClusters).values(row);
  return row;
}

export async function updateCluster(
  id: string,
  patch: { name?: string; weight?: number; enabled?: boolean },
): Promise<ClusterRow | null> {
  const set: Record<string, unknown> = { updatedAt: nowIso() };
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120);
  if (patch.weight !== undefined) set.weight = patch.weight;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  await db.update(keywordClusters).set(set).where(eq(keywordClusters.id, id));
  const rows = await db
    .select()
    .from(keywordClusters)
    .where(eq(keywordClusters.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// --- tracked keywords -------------------------------------------------------

interface CreateKeywordInput {
  keyword: string;
  priority?: Priority;
  clusterId?: string | null;
  locationCode?: number;
  languageCode?: string;
  alertingEnabled?: boolean;
  /** `bootstrap` for a seeded row, `manual` for one a human added. */
  createdSource?: "bootstrap" | "manual";
}

/**
 * Create one tracked keyword, auto-clustering when no cluster is given.
 *
 * Returns null when the keyword already exists for that market — the caller
 * treats that as a skip, not an error, so a re-import is idempotent.
 */
export async function createTrackedKeyword(
  input: CreateKeywordInput,
  clusters: ClusterRow[],
): Promise<TrackedKeywordRow | null> {
  if (!isValidKeyword(input.keyword)) {
    throw new KeywordValidationError(
      "Keyword must be between 2 and 200 characters",
      "keyword_invalid",
    );
  }
  const normalized = normalizeKeyword(input.keyword);
  const priority = input.priority ?? "normal";
  const rule = classifyKeyword(normalized);
  const clusterId =
    input.clusterId ?? clusters.find((c) => c.slug === rule?.slug)?.id ?? null;

  const row = {
    id: newId("tk"),
    keyword: input.keyword.trim().slice(0, 200),
    normalizedKeyword: normalized,
    clusterId,
    priority,
    locationCode: input.locationCode ?? 2380,
    languageCode: input.languageCode ?? "it",
    device: "desktop" as const,
    trackingFrequencyHours: frequencyHoursFor(priority),
    trackingEnabled: true,
    alertingEnabled: input.alertingEnabled ?? true,
    searchVolume: null,
    createdSource: input.createdSource ?? "manual",
    lastCheckedAt: null,
    // Due immediately: a newly added keyword should be measured on the next
    // tick rather than waiting out a full interval.
    nextCheckAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    disabledAt: null,
  };
  try {
    await db.insert(trackedKeywords).values(row);
    return row;
  } catch {
    return null; // already tracked for this market
  }
}

export async function bulkImportKeywords(
  inputs: readonly CreateKeywordInput[],
): Promise<{ created: number; skipped: number }> {
  const clusters = await listClusters();
  let created = 0;
  let skipped = 0;
  for (const input of inputs) {
    const row = await createTrackedKeyword(input, clusters);
    if (row) created += 1;
    else skipped += 1;
  }
  return { created, skipped };
}

/**
 * One tracked keyword by id.
 *
 * The live path needs this because it recomputes derived state for keywords a
 * COLLECTION touched, which is a different set from the keywords a tick found
 * due — a SERP bought two ticks ago lands now.
 */
export async function getTrackedKeyword(
  id: string,
): Promise<TrackedKeywordRow | null> {
  const rows = await db
    .select()
    .from(trackedKeywords)
    .where(eq(trackedKeywords.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listTrackedKeywords(
  options: {
    includeDisabled?: boolean;
  } = {},
): Promise<TrackedKeywordRow[]> {
  const rows = await db
    .select()
    .from(trackedKeywords)
    .orderBy(trackedKeywords.priority, trackedKeywords.normalizedKeyword);
  return options.includeDisabled ? rows : rows.filter((r) => r.trackingEnabled);
}

export async function updateTrackedKeyword(
  id: string,
  patch: {
    priority?: Priority;
    clusterId?: string | null;
    trackingEnabled?: boolean;
    alertingEnabled?: boolean;
    searchVolume?: number | null;
  },
): Promise<TrackedKeywordRow | null> {
  const set: Record<string, unknown> = { updatedAt: nowIso() };
  if (patch.priority !== undefined) {
    set.priority = patch.priority;
    // The cadence follows the priority; changing one without the other would
    // leave a critical keyword on a fortnightly schedule.
    set.trackingFrequencyHours = frequencyHoursFor(patch.priority);
  }
  if (patch.clusterId !== undefined) set.clusterId = patch.clusterId;
  if (patch.trackingEnabled !== undefined) {
    set.trackingEnabled = patch.trackingEnabled;
    set.disabledAt = patch.trackingEnabled ? null : nowIso();
  }
  if (patch.alertingEnabled !== undefined)
    set.alertingEnabled = patch.alertingEnabled;
  if (patch.searchVolume !== undefined) set.searchVolume = patch.searchVolume;
  await db.update(trackedKeywords).set(set).where(eq(trackedKeywords.id, id));
  const rows = await db
    .select()
    .from(trackedKeywords)
    .where(eq(trackedKeywords.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Keywords whose scheduled check is due, highest priority first.
 *
 * The ordering is the budget policy in SQL: when the cap bites mid-run, the
 * work that got done is the work that mattered most (§14).
 */
export async function dueKeywords(
  limit: number,
  now: Date = new Date(),
  /**
   * Buy these keywords and no others.
   *
   * Priority order is the right DEFAULT policy and the wrong one for a single
   * authorised purchase: the watchlist holds keywords whose search volume is
   * unknown, and priority alone will happily spend on them. `critical` says
   * "this matters to the brand"; it does not say "a measurement of it can be
   * weighted by anything". An operator closing a specific coverage gap needs to
   * name the keywords, exactly as `keyword-volume-refresh` already allows.
   *
   * Narrowing only: a named keyword must still be tracking-enabled and due, so
   * this cannot be used to bypass the cadence or to re-buy something already
   * collected today.
   */
  onlyIds?: readonly string[],
): Promise<TrackedKeywordRow[]> {
  const rows = await db
    .select()
    .from(trackedKeywords)
    .where(eq(trackedKeywords.trackingEnabled, true));
  const priorityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  const wanted = onlyIds && onlyIds.length > 0 ? new Set(onlyIds) : null;
  return rows
    .filter((r) => wanted === null || wanted.has(r.id))
    .filter(
      (r) =>
        !r.nextCheckAt || new Date(r.nextCheckAt).getTime() <= now.getTime(),
    )
    .toSorted(
      (a, b) =>
        (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9),
    )
    .slice(0, limit);
}

export async function markChecked(
  id: string,
  frequencyHours: number,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(trackedKeywords)
    .set({
      lastCheckedAt: now.toISOString(),
      nextCheckAt: new Date(
        now.getTime() + frequencyHours * 3_600_000,
      ).toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(eq(trackedKeywords.id, id));
}

// --- rank snapshots ---------------------------------------------------------

interface RecordRankInput {
  trackedKeywordId: string;
  entityId: string;
  locationCode: number;
  languageCode: string;
  rankGroup: number | null;
  rankAbsolute: number | null;
  rankingUrl: string | null;
  provider: "dataforseo" | "fixture";
  /** The host the ranking URL resolved to, after normalization. */
  rankingDomain?: string | null;
  /** The SERP element the position came from — `organic` for a real ranking. */
  resultType?: string | null;
  /**
   * `partial` marks an observation the provider could not fully answer. It is
   * stored so nothing downstream mistakes it for a measurement — in particular
   * it can never confirm a lost ranking.
   */
  snapshotStatus?: "complete" | "partial";
  snapshotStatusReason?: string | null;
  /** The queued task this came from; the accounting correlation id. */
  providerTaskId?: string | null;
  estimatedCostMicros?: number;
  actualCostMicros?: number;
  now?: Date;
}

export async function recordRank(input: RecordRankInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const snapshotDate = today(now);
  const dedupeKey = `${input.trackedKeywordId}|${input.entityId}|${snapshotDate}`;
  try {
    await db.insert(siRankSnapshots).values({
      id: newId("rs"),
      trackedKeywordId: input.trackedKeywordId,
      entityId: input.entityId,
      snapshotAt: now.toISOString(),
      snapshotDate,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      device: "desktop",
      rankGroup: input.rankGroup,
      rankAbsolute: input.rankAbsolute,
      rankingUrl: input.rankingUrl,
      normalizedRankingUrl: input.rankingUrl
        ? normalizePageUrl(input.rankingUrl).slice(0, 2000)
        : null,
      // Absence is recorded as absence, never as a sentinel position.
      isFound: input.rankGroup !== null,
      rankingDomain: input.rankingDomain ?? null,
      resultType: input.resultType ?? null,
      snapshotStatus: input.snapshotStatus ?? "complete",
      snapshotStatusReason: input.snapshotStatusReason ?? null,
      providerTaskId: input.providerTaskId ?? null,
      provider: input.provider,
      estimatedCostMicros: input.estimatedCostMicros ?? 0,
      actualCostMicros: input.actualCostMicros ?? 0,
      dedupeKey,
      createdAt: now.toISOString(),
    });
    return true;
  } catch {
    return false; // already recorded for today
  }
}

/** Observations for one keyword on a given date, shaped for the pure logic. */
export async function observationsFor(
  trackedKeywordId: string,
  snapshotDate: string,
): Promise<Observation[]> {
  const rows = await db
    .select()
    .from(siRankSnapshots)
    .where(
      and(
        eq(siRankSnapshots.trackedKeywordId, trackedKeywordId),
        eq(siRankSnapshots.snapshotDate, snapshotDate),
      ),
    );
  return rows.map((r) => ({
    entityId: r.entityId,
    rankGroup: r.rankGroup,
    isFound: r.isFound,
    rankingUrl: r.rankingUrl,
  }));
}

/** The distinct snapshot dates for a keyword, newest first. */
export async function recentSnapshotDates(
  trackedKeywordId: string,
  limit = 3,
): Promise<string[]> {
  const rows = await db
    .select({ snapshotDate: siRankSnapshots.snapshotDate })
    .from(siRankSnapshots)
    .where(eq(siRankSnapshots.trackedKeywordId, trackedKeywordId))
    .orderBy(desc(siRankSnapshots.snapshotDate));
  return [...new Set(rows.map((r) => r.snapshotDate))].slice(0, limit);
}

export async function rankHistory(
  trackedKeywordId: string,
  sinceDate: string,
): Promise<RankSnapshotRow[]> {
  return db
    .select()
    .from(siRankSnapshots)
    .where(
      and(
        eq(siRankSnapshots.trackedKeywordId, trackedKeywordId),
        gte(siRankSnapshots.snapshotDate, sinceDate),
      ),
    )
    .orderBy(siRankSnapshots.snapshotDate);
}
