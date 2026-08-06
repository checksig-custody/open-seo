import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { siBacklinkUsageLedger } from "@/db/schema";
import { newId, nowIso } from "./ids";
import type { Phase0Config } from "../phase0-env";
import { resolveProviderStatus } from "./service";

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
  options: { reservedForOtherPhasesUsd?: number; now?: Date } = {},
): Promise<{ allowed: boolean; reason: string | null }> {
  const now = options.now ?? new Date();
  const monthlyCap = config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD;
  const dailyCap = config.SEO_DATAFORSEO_DAILY_COST_CAP_USD;
  if (monthlyCap === 0 || dailyCap === 0) {
    return {
      allowed: false,
      reason: "cost caps are zero; paid collection is disabled",
    };
  }
  const [monthly, daily] = await Promise.all([
    totals({ month: now.toISOString().slice(0, 7) }),
    totals({ day: now.toISOString().slice(0, 10) }),
  ]);
  const reserved = options.reservedForOtherPhasesUsd ?? 0;
  if (monthly.actualCostMicros / MICROS >= Math.max(0, monthlyCap - reserved)) {
    return { allowed: false, reason: "monthly backlink allowance exhausted" };
  }
  if (daily.actualCostMicros / MICROS >= dailyCap) {
    return { allowed: false, reason: "daily cost cap reached" };
  }
  return { allowed: true, reason: null };
}
