import { eq } from "drizzle-orm";
import { db } from "@/db";
import { siProviderState } from "@/db/search-intelligence-budget.schema";
import {
  classifyProviderAccountEvent,
  isLatched,
  PROVIDER,
  type ProviderAccountEvent,
  type ProviderCircuitState,
} from "./provider-events";

/**
 * Morgana Search Intelligence — the latched provider-account circuit breaker,
 * and its persistence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P20).
 *
 * The DECISION lives in `provider-events.ts`, which is pure and therefore
 * testable; this file is what remembers it. The two are separate because the
 * decision is the part that must never be wrong, and it cannot be exercised
 * from a test while it sits next to a D1 import.
 *
 * WHY LATCHED. DataForSEO answers `40201` when it has SUSPENDED the account —
 * a statement about the credential every collector shares, not about one call.
 * The existing breaker in `budget.ts` counts consecutive failures and closes
 * itself after a cooldown, which is right for a provider having a bad ten
 * minutes and exactly wrong here: each cooldown expiry would resume calling a
 * dead account, from every collector, forever.
 *
 * So nothing on the automatic path clears this. `clearProviderState` is the only
 * exit and it demands an actor and a reason.
 */

// Re-exported so callers that only need the breaker import one module. Kept to
// what is actually consumed: `isLatched` and `PROVIDER` are used inside this
// file and imported directly by anyone else, and an unused re-export is a
// public surface nobody asked for.
export {
  classifyProviderAccountEvent,
  sanitizeProviderMessage,
} from "./provider-events";
export type { ProviderCircuitState } from "./provider-events";

interface ProviderStateRow {
  provider: string;
  state: ProviderCircuitState;
  detectedAt: string;
  lastCheckedAt: string | null;
  clearedAt: string | null;
  clearReason: string | null;
  clearedBy: string | null;
  endpoint: string | null;
  operationType: string | null;
  providerStatusCode: number | null;
  sanitizedMessage: string | null;
  jobId: string | null;
  operationId: string | null;
  requiresAttention: boolean;
  credentialGeneration: string | null;
  updatedAt: string;
}

/**
 * The current verdict, or null when the provider has never been observed.
 *
 * NULL IS NOT HEALTHY. A subsystem that has never called the provider knows
 * nothing about it, and reporting that as healthy is the same class of mistake
 * as reporting implementation as verification. Callers decide what to do with
 * "unknown"; this function will not decide it for them.
 */
export async function readProviderState(
  provider: string = PROVIDER,
): Promise<ProviderStateRow | null> {
  const rows = await db
    .select()
    .from(siProviderState)
    .where(eq(siProviderState.provider, provider))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, state: row.state as ProviderCircuitState };
}

/**
 * May a paid operation proceed?
 *
 * Returns a typed refusal rather than throwing, because every caller is already
 * inside a decision that has to be recorded, and an exception here would be
 * indistinguishable from the provider failure it is trying to prevent.
 */
export async function providerBlock(
  provider: string = PROVIDER,
): Promise<
  | { blocked: false }
  | { blocked: true; state: ProviderCircuitState; reason: string }
> {
  const row = await readProviderState(provider);
  if (!row || !isLatched(row.state)) return { blocked: false };
  return {
    blocked: true,
    state: row.state,
    reason:
      row.state === "account_suspended"
        ? `provider account suspended since ${row.detectedAt}; no request may be sent until a human clears it`
        : row.state === "auth_failed"
          ? `provider credential was rejected at ${row.detectedAt}; rotate it and clear the breaker`
          : `provider account is not entitled to this API (since ${row.detectedAt})`,
  };
}

/**
 * Latch a provider-account state.
 *
 * `detected_at` is preserved when the same state is re-observed, so "suspended
 * since" survives every later touch. Re-observing a DIFFERENT state overwrites,
 * because the newer observation is the truer one — an account that was
 * rate-limited and is now suspended is suspended.
 */
export async function latchProviderState(input: {
  provider?: string;
  state: Exclude<ProviderCircuitState, "healthy">;
  endpoint?: string | null;
  operationType?: string | null;
  providerStatusCode?: number | null;
  sanitizedMessage?: string | null;
  jobId?: string | null;
  operationId?: string | null;
  credentialGeneration?: string | null;
  now?: Date;
}): Promise<void> {
  const provider = input.provider ?? PROVIDER;
  const now = (input.now ?? new Date()).toISOString();
  const existing = await readProviderState(provider);
  const detectedAt =
    existing && existing.state === input.state ? existing.detectedAt : now;

  const values = {
    provider,
    state: input.state,
    detectedAt,
    lastCheckedAt: now,
    // A newly latched state is not a cleared one. Any previous clearance is
    // history and must not read as though it applied to this observation.
    clearedAt: null,
    clearReason: null,
    clearedBy: null,
    endpoint: input.endpoint ?? null,
    operationType: input.operationType ?? null,
    providerStatusCode: input.providerStatusCode ?? null,
    sanitizedMessage: input.sanitizedMessage ?? null,
    jobId: input.jobId ?? null,
    operationId: input.operationId ?? null,
    requiresAttention: true,
    credentialGeneration: input.credentialGeneration ?? null,
    updatedAt: now,
  };

  await db
    .insert(siProviderState)
    .values(values)
    .onConflictDoUpdate({ target: siProviderState.provider, set: values });
}

/**
 * Record that a FREE check found the account usable.
 *
 * This is the one automatic path allowed to write `healthy`, and only because
 * it costs nothing and asks the provider directly. It still cannot silently
 * clear a latch: `clearProviderState` does that, and it needs a reason.
 */
export async function recordProviderHealthy(input: {
  provider?: string;
  credentialGeneration?: string | null;
  now?: Date;
}): Promise<void> {
  const provider = input.provider ?? PROVIDER;
  const now = (input.now ?? new Date()).toISOString();
  const existing = await readProviderState(provider);
  const detectedAt =
    existing && existing.state === "healthy" ? existing.detectedAt : now;
  const values = {
    provider,
    state: "healthy" as const,
    detectedAt,
    lastCheckedAt: now,
    clearedAt: existing?.clearedAt ?? null,
    clearReason: existing?.clearReason ?? null,
    clearedBy: existing?.clearedBy ?? null,
    endpoint: null,
    operationType: null,
    providerStatusCode: null,
    sanitizedMessage: null,
    jobId: null,
    operationId: null,
    requiresAttention: false,
    credentialGeneration:
      input.credentialGeneration ?? existing?.credentialGeneration ?? null,
    updatedAt: now,
  };
  await db
    .insert(siProviderState)
    .values(values)
    .onConflictDoUpdate({ target: siProviderState.provider, set: values });
}

/** Why a clearance was refused. Each one is a missing deliberate act. */
type ClearRefusal =
  | "not_latched"
  | "actor_required"
  | "reason_required"
  | "not_found";

/**
 * The only exit from a latch, and it is never automatic.
 *
 * Three legitimate grounds, all of them acts somebody performed: the credential
 * generation changed (a different account is installed), an admin decided to
 * re-check, or a free health check demonstrated the account is usable. The
 * caller states which; this function insists that somebody is named and that a
 * reason is written down.
 *
 * `detected_at` is NOT reset. When the account was suspended stays answerable
 * after it is cleared, which is the whole value of an audit trail.
 */
export async function clearProviderState(input: {
  provider?: string;
  actor: string;
  reason: string;
  credentialGeneration?: string | null;
  now?: Date;
}): Promise<{ cleared: true } | { cleared: false; refusal: ClearRefusal }> {
  const provider = input.provider ?? PROVIDER;
  if (input.actor.trim() === "")
    return { cleared: false, refusal: "actor_required" };
  if (input.reason.trim() === "")
    return { cleared: false, refusal: "reason_required" };

  const existing = await readProviderState(provider);
  if (!existing) return { cleared: false, refusal: "not_found" };
  if (!isLatched(existing.state)) {
    return { cleared: false, refusal: "not_latched" };
  }

  const now = (input.now ?? new Date()).toISOString();
  await db
    .update(siProviderState)
    .set({
      state: "healthy",
      clearedAt: now,
      clearReason: input.reason.trim().slice(0, 300),
      clearedBy: input.actor.trim().slice(0, 200),
      requiresAttention: false,
      lastCheckedAt: now,
      credentialGeneration:
        input.credentialGeneration ?? existing.credentialGeneration,
      updatedAt: now,
    })
    .where(eq(siProviderState.provider, provider));
  return { cleared: true };
}

/**
 * Observe a thrown provider error and latch if it was an account event.
 *
 * Returns what it decided so the caller can record the same verdict on its own
 * row rather than re-deriving it. `rate_limited` and `none` write NOTHING —
 * turning a busy minute into a permanent outage is the failure mode this whole
 * file is shaped to avoid.
 */
export async function observeProviderError(
  error: unknown,
  context: {
    endpoint?: string | null;
    operationType?: string | null;
    jobId?: string | null;
    operationId?: string | null;
    credentialGeneration?: string | null;
    provider?: string;
    now?: Date;
  } = {},
): Promise<ProviderAccountEvent> {
  const event = classifyProviderAccountEvent(error);
  if (event.kind === "none" || event.kind === "rate_limited") return event;
  await latchProviderState({
    provider: context.provider,
    state: event.kind,
    endpoint: context.endpoint ?? null,
    operationType: context.operationType ?? null,
    providerStatusCode: event.statusCode,
    sanitizedMessage: event.sanitizedMessage,
    jobId: context.jobId ?? null,
    operationId: context.operationId ?? null,
    credentialGeneration: context.credentialGeneration ?? null,
    now: context.now,
  });
  return event;
}
