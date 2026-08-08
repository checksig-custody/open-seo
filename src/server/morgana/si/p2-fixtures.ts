import * as p2 from "./p2-store";
import type { SearchEntityRow } from "./store";

/**
 * Morgana Search Intelligence — staging's synthetic rankings.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Its own module so that the one thing a production tick must never do is a
 * single import away from the tick, rather than a branch buried inside it. A
 * production engine refuses this path outright; see the fixture guard in
 * `p2-service.ts`.
 */

/** Deterministic fixture rank, so the whole pipeline runs without a credential. */
function fixtureRank(
  keyword: string,
  domain: string,
  date: string,
): number | null {
  let h = 2166136261;
  for (const ch of `${keyword}|${domain}|${date}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const v = Math.abs(h) % 100;
  // Roughly a quarter of keyword/domain pairs do not rank at all — the case the
  // UI and the maths must handle, so the fixtures must produce it.
  if (v >= 75) return null;
  return 1 + (v % 40);
}

/**
 * Staging's synthetic rankings, one per entity.
 *
 * Never reached in production — the caller refuses the fixture path there — and
 * kept in its own function so that refusal is a single condition rather than a
 * branch buried in the tick.
 */
export async function recordFixtureRanks(input: {
  entities: readonly SearchEntityRow[];
  keyword: {
    id: string;
    normalizedKeyword: string;
    locationCode: number;
    languageCode: string;
  };
  date: string;
  now: Date;
}): Promise<number> {
  let recordedCount = 0;
  for (const entity of input.entities) {
    const rank = fixtureRank(
      input.keyword.normalizedKeyword,
      entity.normalizedDomain,
      input.date,
    );
    const recorded = await p2.recordRank({
      trackedKeywordId: input.keyword.id,
      entityId: entity.id,
      locationCode: input.keyword.locationCode,
      languageCode: input.keyword.languageCode,
      rankGroup: rank,
      rankAbsolute: rank === null ? null : rank + 2,
      rankingUrl:
        rank === null
          ? null
          : `https://${entity.normalizedDomain}/${input.keyword.normalizedKeyword.replace(/\s+/g, "-")}`,
      provider: "fixture",
      now: input.now,
    });
    if (recorded) recordedCount += 1;
  }
  return recordedCount;
}
