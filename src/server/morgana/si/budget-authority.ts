import { and, eq, inArray, like, lt, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import { searchUsageLedger } from "@/db/search-intelligence.schema";
import { phase2UsageLedger } from "@/db/search-intelligence-p2.schema";
import { siBacklinkUsageLedger } from "@/db/search-intelligence-p3.schema";
import { siBudgetReservations } from "@/db/search-intelligence-budget.schema";
import { isEnabled, type Phase0Config } from "../phase0-env";
import { newId } from "./ids";

/**
 * Morgana Search Intelligence — the one authority that may allow spending.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P14).
 *
 * THE INCIDENT THIS REPLACES. Every collector had its own ledger and its own
 * guard, and each guard compared its own spend against the shared 0.20 USD cap.
 * On 2026-08-06 the backlink guard saw zero backlink spend, allowed a 0.0792 USD
 * collection, and the day summed to 0.21400 USD. Nothing was bypassed. There was
 * simply no guard that could see the total, and four correct local answers added
 * up to a wrong global one.
 *
 * TWO THINGS ARE THEREFORE TRUE HERE AND NOWHERE ELSE:
 *
 * 1. The spend it reads is the sum of EVERY Search Intelligence ledger. Adding a
 *    fifth collector means adding its ledger to `LEDGERS` — and the aggregate is
 *    a single query set, so forgetting is visible rather than silent.
 * 2. Capacity is RESERVED before the call, not merely checked. A check followed
 *    by a call is not a guard when two collectors run at once: both read the same
 *    remainder, both proceed, and the cap is discovered afterwards.
 *
 * WHAT D1 CAN AND CANNOT DO. There are no interactive transactions, so the
 * atomic unit here is RESERVE-THEN-VERIFY: insert the reservation (its unique
 * idempotency key is the real lock), then re-read the aggregate INCLUDING it.
 * If the total now exceeds the cap the reservation is released and the caller is
 * denied. Two racing callers both insert, both re-read, and at least one sees
 * the other's reservation — so the overrun is refused rather than discovered in
 * a ledger the next morning. The window that remains is bounded by the worst
 * case, never by the real cost.
 *
 * Brand Monitoring is NOT included, deliberately: separate Worker, separate D1,
 * separate DataForSEO account, separate budget. Mixing them would make one
 * subsystem's spend able to starve the other.
 */

/**
 * Every ledger a paid Search Intelligence operation can write to.
 *
 * Each entry brings its own reader because the four tables are structurally
 * different types; a shared generic reader collapses their union and stops
 * type-checking the very columns this depends on. Adding a fifth collector
 * means adding a line here — and the aggregate below reads the whole list, so
 * forgetting shows up as a missing collector in the diagnostics rather than as
 * money nobody counted.
 */
const LEDGERS = [
  {
    name: "shared",
    read: (period: string) => sumLedger(searchUsageLedger, period),
  },
  {
    name: "phase2_jobs",
    read: (period: string) => sumLedger(phase2UsageLedger, period),
  },
  {
    name: "backlinks",
    read: (period: string) => sumLedger(siBacklinkUsageLedger, period),
  },
] as const;

/**
 * The collectors reported inside `search_usage_ledger`.
 *
 * THREE OF THEM SHARE ONE TABLE — the phase-1 Domain Overview collector, SERP
 * ranking and Keyword Volume — and reading it as a whole reported every
 * micro-USD of all three under the first name anyone gave it. Ranking spend was
 * attributed to a collector that had not made the call, and ranking itself
 * showed a null cost while demonstrably having been paid for.
 *
 * `unattributed` is a real bucket, not a fallback: a row written before the
 * cost centre existed, or by a future caller that forgets to label itself, is
 * reported as unattributed rather than folded into a collector that may not
 * have spent it.
 */
const SHARED_LEDGER_CENTRES = [
  "domain_overview",
  "ranking",
  "keyword_volume",
  "unattributed",
] as const;

/**
 * SITE AUDIT IS DELIBERATELY ABSENT, and this is not an oversight.
 *
 * `si_site_audit_usage_ledger` has no cost columns at all — it measures
 * requests, bytes, pages and blocks, because Site Audit crawls first-party
 * pages and buys nothing from any provider. Summing it would mean inventing a
 * money column for a subsystem that spends none.
 *
 * It was in this list for one deploy, behind a type assertion that silenced the
 * very check that would have caught it, and `SUM(actual_cost_micros)` over a
 * table without that column throws. If Site Audit ever gains a paid provider,
 * it gains a cost column first and this list gains a line — in that order.
 */

/** One ledger's totals over a day (`YYYY-MM-DD`) or a month (`YYYY-MM`). */
async function sumLedger(
  // The four ledgers are structurally different table types with the same three
  // columns this needs. Narrowing to those columns is what lets one reader serve
  // all of them without erasing the type-checking that matters.
  table: {
    actualCostMicros: SQLiteColumn;
    meteredRequests: SQLiteColumn;
    day: SQLiteColumn;
  },
  period: string,
): Promise<{ actualMicros: number; requests: number }> {
  const isMonth = period.length === 7;
  const rows = await db
    .select({
      actual: sql<number>`COALESCE(SUM(${table.actualCostMicros}), 0)`,
      requests: sql<number>`COALESCE(SUM(${table.meteredRequests}), 0)`,
    })
    .from(table as unknown as SQLiteTable)
    .where(isMonth ? like(table.day, `${period}%`) : eq(table.day, period));
  const row = rows[0];
  // A SUM over no rows is 0, and that is a real zero: nothing was spent because
  // nothing was recorded.
  return {
    actualMicros: Number(row?.actual ?? 0),
    requests: Number(row?.requests ?? 0),
  };
}

/**
 * Break the shared ledger into its collectors, in ONE grouped read.
 *
 * Grouped rather than one filtered query per centre, for the property as much as
 * the round trips: a `GROUP BY` over the same rows the total is summed from
 * cannot disagree with that total. Independent `WHERE` clauses could — one typo
 * in a predicate and money silently belongs to nobody — and the whole point of
 * this change is that relabelling must not be able to alter an amount.
 *
 * Reported for display only. `globalSpend` still sums the TABLES for the cap.
 */
async function sharedLedgerByCentre(
  period: string,
): Promise<{ collector: string; actualMicros: number; requests: number }[]> {
  const isMonth = period.length === 7;
  const rows = await db
    .select({
      centre: searchUsageLedger.costCentre,
      actual: sql<number>`COALESCE(SUM(${searchUsageLedger.actualCostMicros}), 0)`,
      requests: sql<number>`COALESCE(SUM(${searchUsageLedger.meteredRequests}), 0)`,
    })
    .from(searchUsageLedger)
    .where(
      isMonth
        ? like(searchUsageLedger.day, `${period}%`)
        : eq(searchUsageLedger.day, period),
    )
    .groupBy(searchUsageLedger.costCentre);

  const byCentre = new Map(
    rows.map((row) => [
      row.centre ?? "unattributed",
      { actualMicros: Number(row.actual), requests: Number(row.requests) },
    ]),
  );
  // Every centre is reported, including the ones that spent nothing: a missing
  // row and a zero are the same fact here — nobody was charged — and a collector
  // that vanishes from the report when idle is how "ranking costs nothing"
  // became believable in the first place.
  return SHARED_LEDGER_CENTRES.map((collector) => ({
    collector,
    actualMicros: byCentre.get(collector)?.actualMicros ?? 0,
    requests: byCentre.get(collector)?.requests ?? 0,
  }));
}

/** Reservations that still hold capacity. */
export const HOLDING_STATUSES = ["reserved", "reconciliation_pending"] as const;

type AuthorizationOutcome =
  | { allowed: true; reservationId: string; remainingDailyMicros: number }
  | {
      allowed: false;
      code:
        | "denied_daily_cap"
        | "denied_monthly_cap"
        | "denied_unreconciled_cost"
        | "denied_unexpected_spend"
        | "denied_paid_calls_disabled"
        | "denied_provider_not_configured"
        | "denied_duplicate_operation";
      reason: string;
      /** What the decision was made against, for the diagnostic log. */
      dailySpentMicros: number;
      monthlySpentMicros: number;
      openReservationsMicros: number;
      requestedMicros: number;
    };

interface GlobalSpend {
  day: string;
  month: string;
  dailyActualMicros: number;
  monthlyActualMicros: number;
  openReservationsMicros: number;
  dailyCapMicros: number;
  monthlyCapMicros: number;
  availableDailyMicros: number;
  availableMonthlyMicros: number;
  perCollector: { collector: string; actualMicros: number; requests: number }[];
  overDailyCap: boolean;
  overMonthlyCap: boolean;
  unexpectedSpendDetected: boolean;
  reconciliationPending: number;
}

/**
 * The budget day and month.
 *
 * UTC, because every ledger already keys its `day` column off an ISO timestamp
 * sliced at 10 characters. Changing that silently would re-bucket historical
 * spend, so the definition is stated once here and used by both the ledgers'
 * readers and the reservations.
 */
export function budgetDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function budgetMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

async function openReservationsMicros(day: string): Promise<number> {
  const rows = await db
    .select({
      held: sql<number>`COALESCE(SUM(${siBudgetReservations.estimatedMaxCostMicros}), 0)`,
    })
    .from(siBudgetReservations)
    .where(
      and(
        eq(siBudgetReservations.budgetDay, day),
        inArray(siBudgetReservations.status, [...HOLDING_STATUSES]),
      ),
    );
  return Number(rows[0]?.held ?? 0);
}

/**
 * What the whole subsystem has spent, and what is left.
 *
 * Derived from persisted rows every time. A committed reservation is NOT added
 * on top of the ledger: the ledger already holds that money, and counting both
 * would double it. Only reservations still HOLDING capacity — money authorised
 * but not yet reported — are added.
 */
export async function globalSpend(
  config: Phase0Config,
  options: { now?: Date } = {},
): Promise<GlobalSpend> {
  const now = options.now ?? new Date();
  const day = budgetDay(now);
  const month = budgetMonth(now);

  // THE CAP IS SUMMED FROM THE TABLES; the report is broken out separately.
  //
  // Keeping those two apart is what makes the attribution fix incapable of
  // changing an amount. `dailyActualMicros` is the same `SUM` over the same
  // three tables it has always been — a cost centre is a label the display
  // reads, and no relabelling can move the total the cap is compared against.
  const byLedger = await Promise.all(
    LEDGERS.map(async (ledger) => {
      const totals = await ledger.read(day);
      return {
        collector: ledger.name,
        actualMicros: totals.actualMicros,
        requests: totals.requests,
      };
    }),
  );
  const monthly = await Promise.all(
    LEDGERS.map((ledger) => ledger.read(month)),
  );

  // The shared ledger, broken into the collectors that actually wrote it.
  const perCollector = [
    ...(await sharedLedgerByCentre(day)),
    ...byLedger.filter((row) => row.collector !== "shared"),
  ];

  const dailyActualMicros = byLedger.reduce(
    (sum, row) => sum + row.actualMicros,
    0,
  );
  const monthlyActualMicros = monthly.reduce(
    (sum, row) => sum + row.actualMicros,
    0,
  );
  const held = await openReservationsMicros(day);

  const pending = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(siBudgetReservations)
    .where(eq(siBudgetReservations.status, "reconciliation_pending"));
  const exceeded = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(siBudgetReservations)
    .where(eq(siBudgetReservations.failureReason, "ESTIMATE_EXCEEDED"));

  const dailyCapMicros = config.SEO_DATAFORSEO_DAILY_COST_CAP_USD;
  const monthlyCapMicros = config.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD;

  return {
    day,
    month,
    dailyActualMicros,
    monthlyActualMicros,
    openReservationsMicros: held,
    dailyCapMicros,
    monthlyCapMicros,
    // Negative when the cap has already been exceeded, which is exactly what
    // happened on 2026-08-06 and must stay visible rather than clamped to zero.
    availableDailyMicros: dailyCapMicros - dailyActualMicros - held,
    availableMonthlyMicros: monthlyCapMicros - monthlyActualMicros - held,
    perCollector,
    overDailyCap: dailyActualMicros + held > dailyCapMicros,
    overMonthlyCap: monthlyActualMicros + held > monthlyCapMicros,
    unexpectedSpendDetected: Number(exceeded[0]?.n ?? 0) > 0,
    reconciliationPending: Number(pending[0]?.n ?? 0),
  };
}

/** How long a reservation may hold capacity before it needs reconciling. */
const RESERVATION_TTL_MS = 15 * 60 * 1000;

/**
 * Authorize one paid operation, or refuse it with a typed reason.
 *
 * The order is the guarantee: configuration first (cheapest and most
 * fundamental), then the reservation, then the re-verified aggregate. A caller
 * that receives `allowed` holds capacity until it commits or releases.
 */
export async function authorizePaidOperation(
  config: Phase0Config,
  input: {
    collector: string;
    operationType: string;
    /** The most this operation could cost. Never an average. */
    worstCaseMicros: number;
    idempotencyKey: string;
    jobId?: string | null;
    operationId?: string | null;
    /**
     * What the operation runs against — a domain, a keyword — and how large a
     * question it asks of it. Recorded so a reservation can be audited rather
     * than only summed: the estimate below is only checkable against the sample
     * size it assumed, and for Backlinks the cost scales with exactly that.
     */
    subject?: string | null;
    subjectScope?: number | null;
    providerConfigured: boolean;
    now?: Date;
  },
): Promise<AuthorizationOutcome> {
  const now = input.now ?? new Date();
  const day = budgetDay(now);
  const month = budgetMonth(now);

  const deny = (
    code: Exclude<AuthorizationOutcome, { allowed: true }>["code"],
    reason: string,
    spend: { daily: number; monthly: number; held: number },
  ): AuthorizationOutcome => ({
    allowed: false,
    code,
    reason,
    dailySpentMicros: spend.daily,
    monthlySpentMicros: spend.monthly,
    openReservationsMicros: spend.held,
    requestedMicros: input.worstCaseMicros,
  });

  const nothing = { daily: 0, monthly: 0, held: 0 };
  if (!input.providerConfigured) {
    return deny(
      "denied_provider_not_configured",
      "no Search Intelligence DataForSEO credential",
      nothing,
    );
  }
  if (!isEnabled(config.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED)) {
    return deny("denied_paid_calls_disabled", "paid calls are off", nothing);
  }

  const before = await globalSpend(config, { now });
  if (before.unexpectedSpendDetected) {
    // A collector has already spent more than it reserved. Until a human has
    // looked at it, the cost model is known to be wrong somewhere, and the
    // right move is to stop rather than to trust the next estimate.
    return deny(
      "denied_unexpected_spend",
      "a previous operation exceeded its estimate; review required",
      {
        daily: before.dailyActualMicros,
        monthly: before.monthlyActualMicros,
        held: before.openReservationsMicros,
      },
    );
  }

  // RESERVE, THEN VERIFY. The insert is the lock: a concurrent caller's
  // reservation becomes visible to the re-read below, so the second one to
  // check is the one that backs off.
  const id = newId("br");
  try {
    await db.insert(siBudgetReservations).values({
      id,
      idempotencyKey: input.idempotencyKey,
      collector: input.collector,
      operationType: input.operationType,
      jobId: input.jobId ?? null,
      operationId: input.operationId ?? null,
      subject: input.subject ?? null,
      subjectScope: input.subjectScope ?? null,
      estimatedMaxCostMicros: input.worstCaseMicros,
      status: "reserved",
      budgetDay: day,
      budgetMonth: month,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS).toISOString(),
    });
  } catch {
    // The unique idempotency key rejected it: this exact operation is already
    // authorised or already ran. Refusing is what makes a retry safe.
    return deny(
      "denied_duplicate_operation",
      "an operation with this idempotency key already holds a reservation",
      {
        daily: before.dailyActualMicros,
        monthly: before.monthlyActualMicros,
        held: before.openReservationsMicros,
      },
    );
  }

  const after = await globalSpend(config, { now });
  const wouldExceedDaily =
    after.dailyActualMicros + after.openReservationsMicros >
    after.dailyCapMicros;
  const wouldExceedMonthly =
    after.monthlyActualMicros + after.openReservationsMicros >
    after.monthlyCapMicros;

  if (wouldExceedDaily || wouldExceedMonthly) {
    await releaseReservation(
      id,
      wouldExceedDaily ? "DAILY_CAP" : "MONTHLY_CAP",
      now,
    );
    return deny(
      wouldExceedDaily ? "denied_daily_cap" : "denied_monthly_cap",
      wouldExceedDaily
        ? "the worst case would exceed the global daily cap"
        : "the worst case would exceed the global monthly cap",
      {
        daily: after.dailyActualMicros,
        monthly: after.monthlyActualMicros,
        held: after.openReservationsMicros,
      },
    );
  }

  return {
    allowed: true,
    reservationId: id,
    remainingDailyMicros: after.availableDailyMicros,
  };
}

/**
 * The operation finished and the provider said what it cost.
 *
 * The ledger holds the money; this row stops holding capacity for it. When the
 * real cost exceeds what was reserved the difference is recorded rather than
 * clamped — that is the Backlinks case, where 79 236 µUSD landed against a
 * 25 000 µUSD estimate — and `ESTIMATE_EXCEEDED` blocks further paid operations
 * until someone has looked at the model.
 */
export async function commitReservation(
  reservationId: string,
  input: {
    actualCostMicros: number | null;
    costStatus: "reported" | "zero" | "not_reported";
    now?: Date;
  },
): Promise<{ estimateExceeded: boolean }> {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(siBudgetReservations)
    .where(eq(siBudgetReservations.id, reservationId))
    .limit(1);
  const reservation = rows[0];
  if (!reservation) return { estimateExceeded: false };

  // A cost that was never reported must NOT release capacity: the call happened
  // and may have been charged, so the worst case keeps being held until someone
  // reconciles it. Releasing here would hand out capacity that is already spent.
  if (input.costStatus === "not_reported" || input.actualCostMicros === null) {
    await db
      .update(siBudgetReservations)
      .set({
        status: "reconciliation_pending",
        costStatus: "not_reported",
        committedAt: now.toISOString(),
      })
      .where(eq(siBudgetReservations.id, reservationId));
    return { estimateExceeded: false };
  }

  const estimateExceeded =
    input.actualCostMicros > reservation.estimatedMaxCostMicros;

  await db
    .update(siBudgetReservations)
    .set({
      status: "committed",
      actualCostMicros: input.actualCostMicros,
      costStatus: input.costStatus,
      committedAt: now.toISOString(),
      failureReason: estimateExceeded ? "ESTIMATE_EXCEEDED" : null,
    })
    .where(eq(siBudgetReservations.id, reservationId));

  return { estimateExceeded };
}

/** Nothing was spent: give the capacity back. */
export async function releaseReservation(
  reservationId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(siBudgetReservations)
    .set({
      status: "released",
      releasedAt: now.toISOString(),
      failureReason: reason,
    })
    .where(eq(siBudgetReservations.id, reservationId));
}

/**
 * Reservations whose process died.
 *
 * They are NOT released automatically: we cannot know whether the provider
 * charged, and releasing capacity for a call that may have cost money is how a
 * cap gets exceeded quietly. They move to `reconciliation_pending`, keep holding
 * their worst case, and wait for a human or a reconciliation pass.
 */
export async function expireStaleReservations(
  now: Date = new Date(),
): Promise<number> {
  const stale = await db
    .update(siBudgetReservations)
    .set({ status: "reconciliation_pending" })
    .where(
      and(
        eq(siBudgetReservations.status, "reserved"),
        lt(siBudgetReservations.expiresAt, now.toISOString()),
      ),
    )
    .returning({ id: siBudgetReservations.id });
  return stale.length;
}
