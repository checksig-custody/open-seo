import { isEnabled, type Phase0Config } from "../phase0-env";
import * as entities from "./store";
import * as store from "./site-audit-store";
import { runAuditBatch } from "./site-audit-crawl";
import {
  MANUAL_COOLDOWN_MS,
  pageLimitFor,
  type CrawlDeps,
  type RunOutcome,
} from "./site-audit-shared";

export { runAuditBatch } from "./site-audit-crawl";

/**
 * Morgana Search Intelligence — Site Audit orchestration.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Requesting an audit and deciding which domain is due. The crawl loop itself
 * lives in `site-audit-crawl.ts` and the close-out in `site-audit-finalize.ts`.
 *
 * Nothing here can be pointed at an arbitrary URL. A run targets a configured
 * `search_entities` row, and every fetch goes through the crawler's boundary
 * with that entity's domain as the only host in scope.
 */

export async function requestAudit(
  config: Phase0Config,
  input: {
    entityId: string;
    trigger: "manual" | "scheduled";
    requestedBy?: string | null;
    pageLimit?: number;
  },
): Promise<RunOutcome> {
  if (!isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED)) {
    return { runId: null, status: "skipped", reason: "site audit is disabled" };
  }
  const entity = await entities.getEntity(input.entityId);
  if (!entity)
    return { runId: null, status: "skipped", reason: "unknown entity" };
  if (!entity.enabled) {
    return { runId: null, status: "skipped", reason: "entity is disabled" };
  }

  const active = await store.activeRunFor(entity.id);
  if (active) {
    return {
      runId: active.id,
      status: active.status === "queued" ? "queued" : "running",
      reason: "a crawl is already in progress for this domain",
    };
  }

  if (input.trigger === "manual") {
    const recent = await store.latestRuns(entity.id, 5);
    const lastManual = recent.find((run) => run.trigger === "manual");
    if (lastManual) {
      const age = Date.now() - new Date(lastManual.createdAt).getTime();
      if (age < MANUAL_COOLDOWN_MS) {
        return {
          runId: lastManual.id,
          status: "skipped",
          reason: "a manual audit for this domain ran within the last 24 hours",
        };
      }
    }
  }

  const pageLimit = pageLimitFor(entity, input.pageLimit);
  const { run } = await store.createRun({
    entityId: entity.id,
    trigger: input.trigger,
    requestedBy: input.requestedBy ?? null,
    pageLimit,
    dedupeKey: store.runDedupeKey(entity.id, input.trigger),
  });
  return {
    runId: run.id,
    status: run.status === "running" ? "running" : "queued",
  };
}

const INTERVAL_HOURS = {
  primary: 168,
  competitorHigh: 336,
  competitor: 720,
} as const;

function auditDueAt(entity: { entityType: string; priority: string }): number {
  if (entity.entityType === "primary") return INTERVAL_HOURS.primary;
  return entity.priority === "high"
    ? INTERVAL_HOURS.competitorHigh
    : INTERVAL_HOURS.competitor;
}

async function selectDueForAudit<
  T extends {
    id: string;
    entityType: string;
    priority: string;
    enabled: boolean;
  },
>(
  candidates: readonly T[],
  lastRunAt: ReadonlyMap<string, string | null>,
  now: Date = new Date(),
): Promise<T[]> {
  return candidates.filter((entity) => {
    if (!entity.enabled) return false;
    const last = lastRunAt.get(entity.id);
    if (!last) return true;
    const dueMs = auditDueAt(entity) * 3600_000;
    return now.getTime() - new Date(last).getTime() >= dueMs;
  });
}

export async function runAuditTick(
  config: Phase0Config,
  deps: CrawlDeps = {},
): Promise<{
  advanced: RunOutcome[];
  started: RunOutcome[];
  skipped: string | null;
}> {
  if (!isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED)) {
    return { advanced: [], started: [], skipped: "site audit is disabled" };
  }
  if (!isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_SCHEDULER_ENABLED)) {
    return { advanced: [], started: [], skipped: "scheduler is disabled" };
  }

  const advanced: RunOutcome[] = [];
  const inFlight = await store.claimableRuns(2);
  for (const run of inFlight.slice(0, 1)) {
    advanced.push(await runAuditBatch(config, run.id, deps));
  }

  const started: RunOutcome[] = [];
  // A new crawl only starts when nothing is in flight: two concurrent crawls
  // would compete for the same invocation budget and finish neither.
  if (inFlight.length === 0) {
    const all = await entities.listEntities();
    const lastRuns = new Map<string, string | null>();
    for (const entity of all) {
      const runs = await store.latestRuns(entity.id, 1);
      lastRuns.set(entity.id, runs[0]?.createdAt ?? null);
    }
    const due = await selectDueForAudit(all, lastRuns);
    for (const entity of due.slice(0, 1)) {
      started.push(
        await requestAudit(config, {
          entityId: entity.id,
          trigger: "scheduled",
        }),
      );
    }
  }

  return { advanced, started, skipped: null };
}
