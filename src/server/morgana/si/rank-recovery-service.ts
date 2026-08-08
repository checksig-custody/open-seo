import { type Phase0Config } from "../phase0-env";
import * as p2 from "./p2-store";
import { recomputeDerivedState } from "./p2-derived";
import { recoverRankTask } from "./rank-collect-service";
import * as store from "./store";

/**
 * Morgana Search Intelligence — recovering a SERP that automatic polling gave
 * up on.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Its own module because it is the only part of collection that needs the
 * entity store and the derived-state recomputation; keeping those imports out
 * of `rank-collect-service.ts` is what lets the collector be unit-tested
 * without the Workers D1 client.
 */

/**
 * Redeem one named receipt, and fold the result into the derived state.
 *
 * The service-level counterpart to `recoverRankTask`: it supplies the entities
 * the SERP is interpreted against, then recomputes the gap and events for the
 * keyword exactly as a scheduled collection would, so a recovered observation
 * is indistinguishable downstream from one collected on time.
 *
 * Buys nothing, and cannot: no keyword selection, no job creation, no
 * `task_post` reachable from this path.
 */
export async function recoverRankTaskById(
  config: Phase0Config,
  taskId: string,
  options: { now?: Date } = {},
): Promise<{
  status: string;
  reason: string;
  observations: number;
  eventsDetected: number;
}> {
  const now = options.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const entities = await store.listEntities();
  const primary = entities.find((e) => e.entityType === "primary");
  const outcome = await recoverRankTask({ taskId, entities, day: date, now });

  let eventsDetected = 0;
  if (outcome.status === "collected" && outcome.trackedKeywordId && primary) {
    const keyword = await p2.getTrackedKeyword(outcome.trackedKeywordId);
    if (keyword) {
      eventsDetected = await recomputeDerivedState({
        config,
        primaryId: primary.id,
        keyword,
        date,
        now,
      });
      await p2.markChecked(keyword.id, keyword.trackingFrequencyHours, now);
    }
  }
  return {
    status: outcome.status,
    reason: outcome.reason,
    observations: outcome.observations,
    eventsDetected,
  };
}
