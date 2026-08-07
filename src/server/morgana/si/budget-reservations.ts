import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { siBudgetReservations } from "@/db/search-intelligence-budget.schema";
import { HOLDING_STATUSES } from "./budget-authority";

/**
 * Morgana Search Intelligence — reading and settling reservations.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P14).
 *
 * Separate from `budget-authority.ts` because the two answer to different
 * questions and change for different reasons: the authority decides whether
 * money MAY be spent, and this decides what to do about money that already was.
 * Splitting them also keeps each inside the repository's module size limit.
 *
 * THE STATE THIS EXISTS FOR. `reconciliation_pending` was terminal with no exit:
 * no function, no endpoint, and no columns recording what a resolution rested
 * on. A row in that state holds its full worst-case capacity forever and counts
 * toward a release blocker no waiver may cover — which creates a standing
 * temptation to make it go away with a plausible number. Every plausible number
 * would be a measurement invented to clear a gate.
 */

/**
 * Every reservation still holding capacity, with what it would take to settle it.
 *
 * READ-ONLY, and it exists because `reconciliation_pending` was a count with
 * nothing behind it. `GET /internal/si/budget` reported a bare `COUNT(*)`, so an
 * operator could see that two reservations were stuck and could not learn which
 * two, what they were for, or what they were holding — while migration `0048`
 * had already added `subject` and `subject_scope` precisely so that question
 * would be answerable. This is the read that makes those columns worth having.
 */
export async function holdingReservations(): Promise<
  {
    id: string;
    collector: string;
    operationType: string;
    subject: string | null;
    subjectScope: number | null;
    jobId: string | null;
    operationId: string | null;
    budgetDay: string;
    budgetMonth: string;
    estimatedMaxCostMicros: number;
    actualCostMicros: number | null;
    costStatus: string | null;
    status: string;
    createdAt: string;
    committedAt: string | null;
    failureReason: string | null;
  }[]
> {
  const rows = await db
    .select()
    .from(siBudgetReservations)
    .where(inArray(siBudgetReservations.status, [...HOLDING_STATUSES]));
  return rows.map((row) => ({
    id: row.id,
    collector: row.collector,
    operationType: row.operationType,
    subject: row.subject,
    subjectScope: row.subjectScope,
    jobId: row.jobId,
    operationId: row.operationId,
    budgetDay: row.budgetDay,
    budgetMonth: row.budgetMonth,
    estimatedMaxCostMicros: row.estimatedMaxCostMicros,
    actualCostMicros: row.actualCostMicros,
    costStatus: row.costStatus,
    status: row.status,
    createdAt: row.createdAt,
    committedAt: row.committedAt,
    failureReason: row.failureReason,
  }));
}

/** Why a reconciliation was refused. Each one is a missing piece of evidence. */
type ResolutionRefusal =
  | "not_found"
  | "not_pending"
  | "cost_not_verified"
  | "evidence_required"
  | "actor_required";

/**
 * Settle a pending reservation against what the provider actually charged.
 *
 * THE ONLY WAY OUT OF `reconciliation_pending`, and it is deliberately hard to
 * take. The temptation is to clear the blocker with the typical price, or the
 * figure a sibling call cost, or a zero — and this subsystem has spent three
 * sessions removing exactly that kind of invented measurement.
 *
 * So all three are required and none has a default: an exact cost somebody
 * verified, the evidence they verified it against, and who they were. A caller
 * that cannot supply all three does not have a reconciliation; it has a guess,
 * and gets a typed refusal instead.
 *
 * The verified figure lands in its OWN column. `actual_cost_micros` keeps saying
 * what the provider reported at the time — which for these rows is nothing at
 * all, and stays true afterwards.
 */
export async function resolveReservation(input: {
  reservationId: string;
  /** Exact, provider-verified, in micro-USD. Never an estimate. */
  verifiedCostMicros: number;
  /** What the figure rests on. An invoice line, an export, a ticket. */
  evidence: string;
  /** Opaque actor reference; never an email. */
  actor: string;
  now?: Date;
}): Promise<
  { resolved: true } | { resolved: false; reason: ResolutionRefusal }
> {
  const now = input.now ?? new Date();

  if (
    !Number.isInteger(input.verifiedCostMicros) ||
    input.verifiedCostMicros < 0
  ) {
    // Micro-USD are integers everywhere in this engine. A float here would be a
    // rounding decision made silently, on the one number nobody may guess.
    return { resolved: false, reason: "cost_not_verified" };
  }
  if (input.evidence.trim() === "") {
    return { resolved: false, reason: "evidence_required" };
  }
  if (input.actor.trim() === "") {
    return { resolved: false, reason: "actor_required" };
  }

  const rows = await db
    .select()
    .from(siBudgetReservations)
    .where(eq(siBudgetReservations.id, input.reservationId))
    .limit(1);
  const reservation = rows[0];
  if (!reservation) return { resolved: false, reason: "not_found" };
  if (reservation.status !== "reconciliation_pending") {
    // Committed and released rows are already settled. Re-resolving one would
    // rewrite a closed record, which is the opposite of an audit trail.
    return { resolved: false, reason: "not_pending" };
  }

  await db
    .update(siBudgetReservations)
    .set({
      status: "resolved",
      resolvedCostMicros: input.verifiedCostMicros,
      resolutionEvidence: input.evidence.trim().slice(0, 500),
      resolvedBy: input.actor.trim().slice(0, 200),
      resolvedAt: now.toISOString(),
    })
    .where(eq(siBudgetReservations.id, input.reservationId));

  return { resolved: true };
}
