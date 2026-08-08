import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { siBacklinkUsageLedger } from "@/db/schema";
import { newId, nowIso } from "./ids";
import type { Phase0Config } from "../phase0-env";
import { resolveProviderStatus } from "./service";
import { WORST_CASE_BACKLINK_MICROS } from "./backlink-live-collector";
import { authorizePaidOperation } from "./budget-authority";

/**
 * Morgana Search Intelligence — phase 3 usage ledger and cost status.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Its own cost centre, `dataforseo_search_backlinks`. Phase 2 shipped with the
 * same string as phase 1 and the two ledgers became indistinguishable; the
 * point of separating them is that "what are backlinks costing us" should be
 * answerable directly rather than by subtracting one total from another.
 *
 * `requests` and `meteredRequests` are separate columns for the reason
 * decision #84 records: a free lifecycle poll that decrements the paid quota
 * starves the work that actually costs money.
 */

const BACKLINK_COST_CENTRE = "dataforseo_search_backlinks";

type MeteringClass =
  | "paid_submission"
  | "free_poll"
  | "result_fetch"
  | "quota_metered_free"
  | "cache";

interface UsageInput {
  entityId: string | null;
  endpointPath: string;
  meteringClass: MeteringClass;
  requests?: number;
  paidTasks?: number;
  backlinksProcessed?: number;
  domainsProcessed?: number;
  cacheHits?: number;
  cacheMisses?: number;
  estimatedCostMicros?: number;
  actualCostMicros?: number;
  /** Correlates this ledger row with the reservation and the snapshot. */
  operationId?: string | null;
}

/** Only these classes consume the paid budget. */
const METERED: ReadonlySet<MeteringClass> = new Set([
  "paid_submission",
  "result_fetch",
]);

export async function recordBacklinkUsage(input: UsageInput): Promise<void> {
  const at = nowIso();
  const day = at.slice(0, 10);
  const requests = input.requests ?? 1;
  const metered = METERED.has(input.meteringClass) ? requests : 0;

  await db
    .insert(siBacklinkUsageLedger)
    .values({
      id: newId("bu"),
      day,
      entityId: input.entityId,
      endpointPath: input.endpointPath,
      meteringClass: input.meteringClass,
      requests,
      meteredRequests: metered,
      paidTasks: input.paidTasks ?? 0,
      resultFetchRequests:
        input.meteringClass === "result_fetch" ? requests : 0,
      backlinksProcessed: input.backlinksProcessed ?? 0,
      domainsProcessed: input.domainsProcessed ?? 0,
      cacheHits: input.cacheHits ?? 0,
      cacheMisses: input.cacheMisses ?? 0,
      estimatedCostMicros: input.estimatedCostMicros ?? 0,
      actualCostMicros: input.actualCostMicros ?? 0,
      // The ledger models "no operation" as the empty string, not NULL — a
      // pre-existing choice of that table, followed here rather than changed.
      operationId: input.operationId ?? "",
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [
        siBacklinkUsageLedger.day,
        siBacklinkUsageLedger.entityId,
        siBacklinkUsageLedger.endpointPath,
        siBacklinkUsageLedger.meteringClass,
      ],
      set: {
        requests: sql`${siBacklinkUsageLedger.requests} + ${requests}`,
        meteredRequests: sql`${siBacklinkUsageLedger.meteredRequests} + ${metered}`,
        paidTasks: sql`${siBacklinkUsageLedger.paidTasks} + ${input.paidTasks ?? 0}`,
        resultFetchRequests: sql`${siBacklinkUsageLedger.resultFetchRequests} + ${input.meteringClass === "result_fetch" ? requests : 0}`,
        backlinksProcessed: sql`${siBacklinkUsageLedger.backlinksProcessed} + ${input.backlinksProcessed ?? 0}`,
        domainsProcessed: sql`${siBacklinkUsageLedger.domainsProcessed} + ${input.domainsProcessed ?? 0}`,
        cacheHits: sql`${siBacklinkUsageLedger.cacheHits} + ${input.cacheHits ?? 0}`,
        cacheMisses: sql`${siBacklinkUsageLedger.cacheMisses} + ${input.cacheMisses ?? 0}`,
        estimatedCostMicros: sql`${siBacklinkUsageLedger.estimatedCostMicros} + ${input.estimatedCostMicros ?? 0}`,
        actualCostMicros: sql`${siBacklinkUsageLedger.actualCostMicros} + ${input.actualCostMicros ?? 0}`,
        updatedAt: at,
      },
    });
}

interface Totals {
  requests: number;
  meteredRequests: number;
  paidTasks: number;
  resultFetchRequests: number;
  backlinksProcessed: number;
  domainsProcessed: number;
  cacheHits: number;
  cacheMisses: number;
  estimatedCostMicros: number;
  actualCostMicros: number;
}

async function totals(where?: {
  day?: string;
  month?: string;
}): Promise<Totals> {
  const rows = await db
    .select({
      requests: sql<number>`coalesce(sum(${siBacklinkUsageLedger.requests}), 0)`,
      meteredRequests: sql<number>`coalesce(sum(${siBacklinkUsageLedger.meteredRequests}), 0)`,
      paidTasks: sql<number>`coalesce(sum(${siBacklinkUsageLedger.paidTasks}), 0)`,
      resultFetchRequests: sql<number>`coalesce(sum(${siBacklinkUsageLedger.resultFetchRequests}), 0)`,
      backlinksProcessed: sql<number>`coalesce(sum(${siBacklinkUsageLedger.backlinksProcessed}), 0)`,
      domainsProcessed: sql<number>`coalesce(sum(${siBacklinkUsageLedger.domainsProcessed}), 0)`,
      cacheHits: sql<number>`coalesce(sum(${siBacklinkUsageLedger.cacheHits}), 0)`,
      cacheMisses: sql<number>`coalesce(sum(${siBacklinkUsageLedger.cacheMisses}), 0)`,
      estimatedCostMicros: sql<number>`coalesce(sum(${siBacklinkUsageLedger.estimatedCostMicros}), 0)`,
      actualCostMicros: sql<number>`coalesce(sum(${siBacklinkUsageLedger.actualCostMicros}), 0)`,
    })
    .from(siBacklinkUsageLedger)
    .where(
      where?.day
        ? eq(siBacklinkUsageLedger.day, where.day)
        : where?.month
          ? sql`substr(${siBacklinkUsageLedger.day}, 1, 7) = ${where.month}`
          : and(),
    );
  const row = rows[0];
  return {
    requests: Number(row?.requests ?? 0),
    meteredRequests: Number(row?.meteredRequests ?? 0),
    paidTasks: Number(row?.paidTasks ?? 0),
    resultFetchRequests: Number(row?.resultFetchRequests ?? 0),
    backlinksProcessed: Number(row?.backlinksProcessed ?? 0),
    domainsProcessed: Number(row?.domainsProcessed ?? 0),
    cacheHits: Number(row?.cacheHits ?? 0),
    cacheMisses: Number(row?.cacheMisses ?? 0),
    estimatedCostMicros: Number(row?.estimatedCostMicros ?? 0),
    actualCostMicros: Number(row?.actualCostMicros ?? 0),
  };
}

interface BacklinkCostStatus {
  costCentre: string;
  providerStatus: string;
  requests: number;
  meteredRequests: number;
  paidTasks: number;
  resultFetchRequests: number;
  backlinksProcessed: number;
  domainsProcessed: number;
  cacheHits: number;
  cacheMisses: number;
  /** Null rather than 0 when nothing has been observed — an unmeasured rate. */
  cacheHitRate: number | null;
  estimatedCostUsd: number;
  actualCostUsd: number;
  dailyCostUsd: number;
  /** Null until at least one backlink has actually been processed. */
  costPerBacklinkUsd: number | null;
  monthlyCapUsd: number;
  dailyCapUsd: number;
  budgetRemainingUsd: number;
  blockedByBudget: number;
}

const MICROS = 1_000_000;

export async function backlinkCostStatus(
  config: Phase0Config,
  env: object,
  options: { now?: Date } = {},
): Promise<BacklinkCostStatus> {
  const now = options.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const [monthly, daily] = await Promise.all([
    totals({ month }),
    totals({ day }),
  ]);

  const cacheTotal = monthly.cacheHits + monthly.cacheMisses;
  const monthlyCapUsd = config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD;
  const actualCostUsd = monthly.actualCostMicros / MICROS;

  return {
    costCentre: BACKLINK_COST_CENTRE,
    providerStatus: resolveProviderStatus(config, env),
    requests: monthly.requests,
    meteredRequests: monthly.meteredRequests,
    paidTasks: monthly.paidTasks,
    resultFetchRequests: monthly.resultFetchRequests,
    backlinksProcessed: monthly.backlinksProcessed,
    domainsProcessed: monthly.domainsProcessed,
    cacheHits: monthly.cacheHits,
    cacheMisses: monthly.cacheMisses,
    cacheHitRate: cacheTotal === 0 ? null : monthly.cacheHits / cacheTotal,
    estimatedCostUsd: monthly.estimatedCostMicros / MICROS,
    actualCostUsd,
    dailyCostUsd: daily.actualCostMicros / MICROS,
    costPerBacklinkUsd:
      monthly.backlinksProcessed === 0
        ? null
        : actualCostUsd / monthly.backlinksProcessed,
    monthlyCapUsd,
    dailyCapUsd: config.SEO_DATAFORSEO_DAILY_COST_CAP_USD,
    budgetRemainingUsd: Math.max(0, monthlyCapUsd - actualCostUsd),
    blockedByBudget: 0,
  };
}

/**
 * May we spend on backlinks right now?
 *
 * Backlinks get only the budget left after keyword tracking and the CheckSig
 * domain overview, so this is checked against the *remaining* allowance rather
 * than against the cap. A zero cap means "cannot spend", which is the correct
 * posture while no credential exists.
 */
export async function backlinkBudgetAllows(
  config: Phase0Config,
  options: {
    reservedForOtherPhasesUsd?: number;
    now?: Date;
    /** Identifies the operation, so a retry cannot reserve capacity twice. */
    idempotencyKey?: string;
    entityId?: string | null;
    /** The domain being collected, and the sample size asked of it. */
    target?: string | null;
    sampleLimit?: number | null;
    jobId?: string | null;
    operationId?: string | null;
  } = {},
): Promise<{
  allowed: boolean;
  reason: string | null;
  reservationId?: string;
}> {
  const now = options.now ?? new Date();

  // THE ONE AUTHORITY. This function used to read `si_backlink_usage_ledger`
  // and compare it against the shared cap — a correct answer to the wrong
  // question, which is how a 0.0792 USD collection was allowed while the day
  // had already spent 0.13476 elsewhere. It now asks the authority that sees
  // every ledger, and holds capacity rather than merely looking at it.
  const decision = await authorizePaidOperation(config, {
    collector: "backlinks",
    operationType: "backlink_collection",
    worstCaseMicros: WORST_CASE_BACKLINK_MICROS,
    // THE ENTITY BELONGS IN THE KEY, and for one deploy it was not there.
    // `entityId` was accepted here and never passed by the only caller, so the
    // key degraded to `backlinks|unknown|<hour>` — a bucket shared by every
    // entity. Collecting a second domain inside the same UTC hour would have
    // been refused as a duplicate of the first, which reads as "already paid
    // for" when nothing of the kind had happened.
    idempotencyKey:
      options.idempotencyKey ??
      `backlinks|${options.entityId ?? "unknown"}|${now.toISOString().slice(0, 13)}`,
    subject: options.target ?? null,
    subjectScope: options.sampleLimit ?? null,
    jobId: options.jobId ?? null,
    operationId: options.operationId ?? null,
    providerConfigured: resolveProviderStatus(config, {}) !== "not_configured",
    now,
  });

  if (!decision.allowed) {
    return { allowed: false, reason: `${decision.code}: ${decision.reason}` };
  }
  return { allowed: true, reason: null, reservationId: decision.reservationId };
}
