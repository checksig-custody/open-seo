import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  domainRefreshJobs,
  domainSnapshotKeywords,
  domainSnapshotPages,
  domainSnapshots,
  searchBudgetState,
  searchEntities,
  searchUsageLedger,
} from "@/db/schema";
import { isMetered, type MeteringClass } from "./budget";
import { normalizeEntityDomain, normalizePageUrl } from "./domains";
import type { SnapshotPoint } from "./metrics";

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

export type EntityType = "primary" | "competitor" | "watch";
export type Priority = "high" | "normal" | "low";

export interface SearchEntityRow {
  id: string;
  displayName: string;
  canonicalDomain: string;
  normalizedDomain: string;
  entityType: EntityType;
  enabled: boolean;
  priority: Priority;
  includeSubdomains: boolean;
  locationCode: number;
  languageCode: string;
  refreshIntervalHours: number;
  backlinkIntervalHours: number;
  lastRefreshedAt: string | null;
  lastBacklinkRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

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

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function nowIso(): string {
  return new Date().toISOString();
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
  const all = rows as unknown as SearchEntityRow[];
  return options.includeDisabled ? all : all.filter((row) => row.enabled);
}

export async function getEntity(id: string): Promise<SearchEntityRow | null> {
  const rows = await db
    .select()
    .from(searchEntities)
    .where(eq(searchEntities.id, id))
    .limit(1);
  return (rows[0] as unknown as SearchEntityRow | undefined) ?? null;
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
}

interface PersistSnapshotResult {
  snapshotId: string;
  created: boolean;
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
    return { snapshotId: existing[0].id, created: false };
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

  if (input.keywords.length > 0) {
    await db.insert(domainSnapshotKeywords).values(
      input.keywords.map((kw, index) => ({
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
        position: index + 1,
      })),
    );
  }

  if (input.pages.length > 0) {
    await db.insert(domainSnapshotPages).values(
      input.pages.map((page, index) => ({
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
        position: index + 1,
      })),
    );
  }

  return { snapshotId, created: true };
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

// --- refresh jobs -----------------------------------------------------------

type JobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

function jobDedupeKey(
  entityId: string,
  snapshotDate: string,
  trigger: "scheduled" | "manual",
): string {
  return `${entityId}|${snapshotDate}|${trigger}`;
}

/**
 * Claim a refresh job. Returns null when an equivalent job already exists —
 * which is the dedup: the UNIQUE index on `dedupe_key` means a duplicated
 * scheduler tick, a double-clicked manual refresh and a retry all collapse onto
 * one job instead of one billable call each.
 */
export async function claimJob(input: {
  entityId: string;
  snapshotDate: string;
  trigger: "scheduled" | "manual";
  requestedBy?: string | null;
}): Promise<{ id: string } | null> {
  const id = newId("rj");
  try {
    await db.insert(domainRefreshJobs).values({
      id,
      entityId: input.entityId,
      status: "running",
      trigger: input.trigger,
      requestedBy: input.requestedBy ?? null,
      dedupeKey: jobDedupeKey(
        input.entityId,
        input.snapshotDate,
        input.trigger,
      ),
      attempts: 1,
      lastError: null,
      skipReason: null,
      estimatedCostMicros: 0,
      actualCostMicros: 0,
      snapshotId: null,
      createdAt: nowIso(),
      startedAt: nowIso(),
      finishedAt: null,
    });
    return { id };
  } catch {
    return null;
  }
}

export async function finishJob(
  id: string,
  patch: {
    status: JobStatus;
    snapshotId?: string | null;
    lastError?: string | null;
    skipReason?: string | null;
    estimatedCostMicros?: number;
    actualCostMicros?: number;
  },
): Promise<void> {
  await db
    .update(domainRefreshJobs)
    .set({
      status: patch.status,
      snapshotId: patch.snapshotId ?? null,
      // Sanitised by the caller; never a stack trace or a credential.
      lastError: patch.lastError?.slice(0, 500) ?? null,
      skipReason: patch.skipReason ?? null,
      estimatedCostMicros: patch.estimatedCostMicros ?? 0,
      actualCostMicros: patch.actualCostMicros ?? 0,
      finishedAt: nowIso(),
    })
    .where(eq(domainRefreshJobs.id, id));
}

export async function getJob(id: string) {
  const rows = await db
    .select()
    .from(domainRefreshJobs)
    .where(eq(domainRefreshJobs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function recentJobs(limit = 50) {
  return db
    .select()
    .from(domainRefreshJobs)
    .orderBy(desc(domainRefreshJobs.createdAt))
    .limit(limit);
}

// --- usage ledger and budget state -----------------------------------------

interface RecordUsageInput {
  day: string;
  entityId?: string | null;
  endpointPath: string;
  meteringClass: MeteringClass;
  estimatedCostMicros?: number;
  actualCostMicros?: number;
  failed?: boolean;
  retry?: boolean;
  blockedByBudget?: boolean;
}

/**
 * Record one call against the ledger.
 *
 * `requests` always increments; `metered_requests` only for classes that
 * actually consume an allowance. That separation is the whole point (decision
 * #84): free lifecycle polls must never ration paid work.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const metered = isMetered(input.meteringClass) ? 1 : 0;
  const isCache = input.meteringClass === "cache";
  const values = {
    id: newId("ul"),
    day: input.day,
    entityId: input.entityId ?? null,
    endpointPath: input.endpointPath,
    meteringClass: input.meteringClass,
    requests: isCache ? 0 : 1,
    meteredRequests: metered,
    failedRequests: input.failed ? 1 : 0,
    retryRequests: input.retry ? 1 : 0,
    estimatedCostMicros: input.estimatedCostMicros ?? 0,
    actualCostMicros: input.actualCostMicros ?? 0,
    cacheHits: isCache ? 1 : 0,
    cacheMisses: isCache ? 0 : 1,
    blockedByBudget: input.blockedByBudget ? 1 : 0,
    updatedAt: nowIso(),
  };
  await db
    .insert(searchUsageLedger)
    .values(values)
    .onConflictDoUpdate({
      target: [
        searchUsageLedger.day,
        searchUsageLedger.endpointPath,
        searchUsageLedger.meteringClass,
      ],
      set: {
        requests: sql`${searchUsageLedger.requests} + ${values.requests}`,
        meteredRequests: sql`${searchUsageLedger.meteredRequests} + ${values.meteredRequests}`,
        failedRequests: sql`${searchUsageLedger.failedRequests} + ${values.failedRequests}`,
        retryRequests: sql`${searchUsageLedger.retryRequests} + ${values.retryRequests}`,
        estimatedCostMicros: sql`${searchUsageLedger.estimatedCostMicros} + ${values.estimatedCostMicros}`,
        actualCostMicros: sql`${searchUsageLedger.actualCostMicros} + ${values.actualCostMicros}`,
        cacheHits: sql`${searchUsageLedger.cacheHits} + ${values.cacheHits}`,
        cacheMisses: sql`${searchUsageLedger.cacheMisses} + ${values.cacheMisses}`,
        blockedByBudget: sql`${searchUsageLedger.blockedByBudget} + ${values.blockedByBudget}`,
        updatedAt: values.updatedAt,
      },
    });
}

interface LedgerTotals {
  requests: number;
  meteredRequests: number;
  paidSubmissions: number;
  freePollRequests: number;
  resultFetchRequests: number;
  failedRequests: number;
  retryRequests: number;
  estimatedCostMicros: number;
  actualCostMicros: number;
  cacheHits: number;
  cacheMisses: number;
  blockedByBudget: number;
}

const ZERO_TOTALS: LedgerTotals = {
  requests: 0,
  meteredRequests: 0,
  paidSubmissions: 0,
  freePollRequests: 0,
  resultFetchRequests: 0,
  failedRequests: 0,
  retryRequests: 0,
  estimatedCostMicros: 0,
  actualCostMicros: 0,
  cacheHits: 0,
  cacheMisses: 0,
  blockedByBudget: 0,
};

/** Ledger totals for a month (`YYYY-MM`) or a single day (`YYYY-MM-DD`). */
export async function ledgerTotals(prefix: string): Promise<LedgerTotals> {
  const rows = await db
    .select()
    .from(searchUsageLedger)
    .where(sql`${searchUsageLedger.day} LIKE ${`${prefix}%`}`);
  const totals: LedgerTotals = { ...ZERO_TOTALS };
  for (const row of rows as unknown as {
    meteringClass: MeteringClass;
    requests: number;
    meteredRequests: number;
    failedRequests: number;
    retryRequests: number;
    estimatedCostMicros: number;
    actualCostMicros: number;
    cacheHits: number;
    cacheMisses: number;
    blockedByBudget: number;
  }[]) {
    totals.requests += row.requests;
    totals.meteredRequests += row.meteredRequests;
    totals.failedRequests += row.failedRequests;
    totals.retryRequests += row.retryRequests;
    totals.estimatedCostMicros += row.estimatedCostMicros;
    totals.actualCostMicros += row.actualCostMicros;
    totals.cacheHits += row.cacheHits;
    totals.cacheMisses += row.cacheMisses;
    totals.blockedByBudget += row.blockedByBudget;
    if (row.meteringClass === "paid_submission")
      totals.paidSubmissions += row.requests;
    if (row.meteringClass === "free_poll")
      totals.freePollRequests += row.requests;
    if (row.meteringClass === "result_fetch")
      totals.resultFetchRequests += row.requests;
  }
  return totals;
}

interface BudgetStateRow {
  month: string;
  monthlyCostMicros: number;
  currentDay: string | null;
  dailyCostMicros: number;
  consecutiveFailures: number;
  circuitOpenedAt: string | null;
  lastAlertThreshold: number | null;
}

export async function readBudgetState(month: string): Promise<BudgetStateRow> {
  const rows = await db
    .select()
    .from(searchBudgetState)
    .where(eq(searchBudgetState.month, month))
    .limit(1);
  const row = rows[0] as unknown as BudgetStateRow | undefined;
  return (
    row ?? {
      month,
      monthlyCostMicros: 0,
      currentDay: null,
      dailyCostMicros: 0,
      consecutiveFailures: 0,
      circuitOpenedAt: null,
      lastAlertThreshold: null,
    }
  );
}

// NOTE: the budget WRITE path (accruing spend, tripping the breaker, recording an
// announced alert threshold) is deliberately absent. Nothing can call it: live
// collection is not implemented in phase 1, so there is no spend to accrue. It
// belongs with the live collector, and shipping it now would be unreachable code
// that knip is right to reject. The READ path above is used and tested.
