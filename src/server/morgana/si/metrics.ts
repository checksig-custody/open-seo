/**
 * Morgana Search Intelligence — derived metrics.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Pure functions, no I/O. The governing rule for this whole file: **a missing
 * value is never a zero**. A domain with no data and a domain with genuinely
 * zero traffic are different facts, and collapsing them produces a comparison
 * table that is confidently wrong — which is worse than an empty one.
 */

type DeltaStatus = "ok" | "insufficient_history" | "not_available";

export interface Delta {
  status: DeltaStatus;
  /** Absolute change. Null unless status is `ok`. */
  absolute: number | null;
  /** Fractional change (0.15 = +15%). Null when the baseline is 0 or absent. */
  relative: number | null;
}

const UNAVAILABLE: Delta = {
  status: "not_available",
  absolute: null,
  relative: null,
};
const NO_HISTORY: Delta = {
  status: "insufficient_history",
  absolute: null,
  relative: null,
};

/**
 * Change between a current and a historical value.
 *
 * `current == null` → `not_available` (we do not know today's value).
 * `previous == null` → `insufficient_history` (we know today, not the past).
 * The distinction matters: the first is a provider gap, the second is a young
 * time series that will heal on its own.
 */
export function computeDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
): Delta {
  if (current === null || current === undefined) return UNAVAILABLE;
  if (previous === null || previous === undefined) return NO_HISTORY;
  const absolute = current - previous;
  // A zero baseline has no meaningful percentage; report the absolute only
  // rather than emitting Infinity.
  const relative = previous === 0 ? null : absolute / previous;
  return { status: "ok", absolute, relative };
}

export interface SnapshotPoint {
  snapshotDate: string;
  organicTrafficEstimate: number | null;
  organicKeywordCount: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
}

export interface DeltaSet {
  trafficDelta1d: Delta;
  trafficDelta7d: Delta;
  trafficDelta30d: Delta;
  keywordCountDelta1d: Delta;
  keywordCountDelta7d: Delta;
  keywordCountDelta30d: Delta;
  backlinkDelta7d: Delta;
  referringDomainDelta7d: Delta;
}

/**
 * Pick the snapshot closest to `daysAgo` before `from`, within a tolerance.
 *
 * Snapshots are not guaranteed daily — a competitor on a weekly cadence has
 * gaps, and a budget stop can create more. Rather than demanding an exact date
 * (which would report `insufficient_history` forever for those entities) we
 * accept the nearest snapshot inside a window, and report the window miss as
 * insufficient history when nothing qualifies.
 */
export function findBaseline(
  history: readonly SnapshotPoint[],
  fromDate: string,
  daysAgo: number,
  toleranceDays = Math.max(1, Math.floor(daysAgo / 2)),
): SnapshotPoint | null {
  const target =
    new Date(`${fromDate}T00:00:00Z`).getTime() - daysAgo * 86_400_000;
  const toleranceMs = toleranceDays * 86_400_000;
  let best: SnapshotPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of history) {
    const time = new Date(`${point.snapshotDate}T00:00:00Z`).getTime();
    if (Number.isNaN(time)) continue;
    const distance = Math.abs(time - target);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

export function computeDeltas(
  current: SnapshotPoint,
  history: readonly SnapshotPoint[],
): DeltaSet {
  // Exclude the current snapshot from its own baselines.
  const past = history.filter((p) => p.snapshotDate < current.snapshotDate);
  const at = (days: number) => findBaseline(past, current.snapshotDate, days);
  const d1 = at(1);
  const d7 = at(7);
  const d30 = at(30);

  return {
    trafficDelta1d: computeDelta(
      current.organicTrafficEstimate,
      d1?.organicTrafficEstimate,
    ),
    trafficDelta7d: computeDelta(
      current.organicTrafficEstimate,
      d7?.organicTrafficEstimate,
    ),
    trafficDelta30d: computeDelta(
      current.organicTrafficEstimate,
      d30?.organicTrafficEstimate,
    ),
    keywordCountDelta1d: computeDelta(
      current.organicKeywordCount,
      d1?.organicKeywordCount,
    ),
    keywordCountDelta7d: computeDelta(
      current.organicKeywordCount,
      d7?.organicKeywordCount,
    ),
    keywordCountDelta30d: computeDelta(
      current.organicKeywordCount,
      d30?.organicKeywordCount,
    ),
    backlinkDelta7d: computeDelta(current.backlinkCount, d7?.backlinkCount),
    referringDomainDelta7d: computeDelta(
      current.referringDomainCount,
      d7?.referringDomainCount,
    ),
  };
}

// --- Estimated Organic Visibility Share ------------------------------------

export type VisibilityShareStatus = "ok" | "insufficient_data";

interface VisibilityShareInput {
  entityId: string;
  organicTrafficEstimate: number | null;
  locationCode: number;
  languageCode: string;
  snapshotDate: string;
}

export interface VisibilityShareResult {
  entityId: string;
  /** 0..1. Null when the share could not be computed honestly. */
  share: number | null;
  status: VisibilityShareStatus;
  reason?: string;
}

export interface VisibilityShareOutcome {
  status: VisibilityShareStatus;
  reason?: string;
  results: VisibilityShareResult[];
}

/**
 * Estimated Organic Visibility Share — each domain's estimated organic traffic
 * as a fraction of the compared set's total.
 *
 * Deliberately NOT called "Share of Search": that term means a share of a
 * controlled keyword basket, which is Phase 2. Naming this one Share of Search
 * would make two different numbers look like the same metric.
 *
 * Refuses to compute, rather than mislead, when:
 *  - fewer than two domains are being compared;
 *  - the compared snapshots are from different markets (traffic estimates are
 *    market-specific, so mixing them is meaningless);
 *  - the snapshots are not contemporaneous (see `maxSpreadDays`);
 *  - any compared domain has no traffic estimate — a missing domain silently
 *    inflates everyone else's share;
 *  - the total is zero.
 */
export function computeVisibilityShare(
  inputs: readonly VisibilityShareInput[],
  options: { maxSpreadDays?: number } = {},
): VisibilityShareOutcome {
  const maxSpreadDays = options.maxSpreadDays ?? 3;

  const insufficient = (reason: string): VisibilityShareOutcome => ({
    status: "insufficient_data",
    reason,
    results: inputs.map((input) => ({
      entityId: input.entityId,
      share: null,
      status: "insufficient_data" as const,
      reason,
    })),
  });

  if (inputs.length < 2) {
    return insufficient("at least two domains are required");
  }

  const markets = new Set(
    inputs.map((i) => `${String(i.locationCode)}|${i.languageCode}`),
  );
  if (markets.size > 1) {
    return insufficient("compared domains use incompatible markets");
  }

  const times = inputs.map((i) =>
    new Date(`${i.snapshotDate}T00:00:00Z`).getTime(),
  );
  if (times.some((t) => Number.isNaN(t))) {
    return insufficient("a snapshot has an unreadable date");
  }
  const spreadDays = (Math.max(...times) - Math.min(...times)) / 86_400_000;
  if (spreadDays > maxSpreadDays) {
    return insufficient("compared snapshots are not contemporaneous");
  }

  if (inputs.some((i) => i.organicTrafficEstimate === null)) {
    return insufficient("a compared domain has no traffic estimate");
  }

  const total = inputs.reduce(
    (sum, i) => sum + (i.organicTrafficEstimate ?? 0),
    0,
  );
  if (total <= 0) {
    return insufficient("total estimated traffic is zero");
  }

  return {
    status: "ok",
    results: inputs.map((input) => ({
      entityId: input.entityId,
      share: (input.organicTrafficEstimate ?? 0) / total,
      status: "ok" as const,
    })),
  };
}
