import { SEED_KEYWORDS, type Priority } from "./keywords";
import * as p2 from "./p2-store";

/**
 * Morgana Search Intelligence — turning the seed watchlist into configuration.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * `SEED_KEYWORDS` has existed since phase 2 as data with nothing reading it.
 * This promotes it into rows an operator can edit, disable or re-prioritise —
 * the point being that after the bootstrap the seed list is no longer the
 * source of truth, the database is. A bootstrap that overwrote edits on every
 * run would make the watchlist un-editable in practice.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by checking first: `ensureDefaultClusters`
 * inserts only missing slugs, and `createTrackedKeyword` returns null when the
 * keyword already exists for that market. Re-running produces skips, never
 * duplicates and never overwrites.
 *
 * CRITICAL AND HIGH ONLY. Every tracked keyword is a recurring paid SERP, so
 * activating sixteen of them at once would multiply the daily spend by sixteen
 * before anyone has seen a single real ranking. `normal` and `low` stay in the
 * seed list, unactivated, and can be added deliberately later.
 */

/** The priorities the bootstrap activates. The rest wait for a human. */
const BOOTSTRAP_PRIORITIES: readonly Priority[] = ["critical", "high"];

interface BootstrapResult {
  clustersCreated: number;
  keywordsCreated: number;
  keywordsSkipped: number;
  /** Keywords in the seed list that this bootstrap deliberately did not add. */
  keywordsDeferred: number;
  created: string[];
}

export async function bootstrapTrackedKeywords(
  options: {
    locationCode?: number;
    languageCode?: string;
  } = {},
): Promise<BootstrapResult> {
  const clustersCreated = await p2.ensureDefaultClusters();
  // Read the clusters AFTER ensuring them, so a first run auto-clusters against
  // the same set a second run would.
  const clusters = await p2.listClusters();

  const result: BootstrapResult = {
    clustersCreated,
    keywordsCreated: 0,
    keywordsSkipped: 0,
    keywordsDeferred: 0,
    created: [],
  };

  for (const seed of SEED_KEYWORDS) {
    if (!BOOTSTRAP_PRIORITIES.includes(seed.priority)) {
      result.keywordsDeferred += 1;
      continue;
    }
    const created = await p2.createTrackedKeyword(
      {
        keyword: seed.keyword,
        priority: seed.priority,
        locationCode: options.locationCode ?? 2380,
        languageCode: options.languageCode ?? "it",
        createdSource: "bootstrap",
      },
      clusters,
    );
    if (created) {
      result.keywordsCreated += 1;
      result.created.push(created.keyword);
    } else {
      // Already present — including one an operator has since edited, which is
      // exactly the row this must not touch.
      result.keywordsSkipped += 1;
    }
  }

  return result;
}
