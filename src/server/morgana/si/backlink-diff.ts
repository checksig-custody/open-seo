/**
 * Morgana Search Intelligence — phase 3 new/lost detection and gap analysis.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * The single most important rule in this file: **absence is not loss.** A
 * backlink missing from the current snapshot means nothing unless that snapshot
 * was complete. A truncated page, an exhausted budget or a provider timeout all
 * produce exactly the same shape as a genuinely removed link, and reporting
 * those as losses would make the whole feature untrustworthy within a week.
 */

type ComparisonStatus = "complete" | "partial" | "not_comparable";

interface SnapshotQuality {
  status: ComparisonStatus;
  reason: string | null;
}

interface SnapshotQualityInput {
  /** Did the provider answer without error? */
  providerOk: boolean;
  /** Rows we actually stored. */
  collected: number;
  /** Rows the provider says exist, when it says so. */
  reportedTotal?: number | null;
  /** Our own per-refresh cap. */
  limit: number;
  /** True when collection stopped because the budget guard fired. */
  budgetTruncated?: boolean;
  /** True when there is no previous snapshot to compare against. */
  noBaseline?: boolean;
}

/**
 * Decide whether a snapshot may be differenced at all.
 *
 * Ordering matters: every "we know it is incomplete" case has to be checked
 * before we conclude completeness from the row count.
 */
export function assessSnapshot(input: SnapshotQualityInput): SnapshotQuality {
  if (!input.providerOk) {
    return { status: "not_comparable", reason: "provider request failed" };
  }
  if (input.noBaseline) {
    return {
      status: "not_comparable",
      reason: "no previous snapshot to compare against",
    };
  }
  if (input.budgetTruncated) {
    return {
      status: "partial",
      reason: "collection stopped by the budget guard",
    };
  }
  if (input.collected >= input.limit) {
    // We hit our own cap, so we cannot tell a removed link from an uncollected
    // one. This is the common case and the one that would silently poison the
    // data if it were treated as complete.
    return {
      status: "partial",
      reason: `collection capped at ${String(input.limit)} rows`,
    };
  }
  if (
    typeof input.reportedTotal === "number" &&
    input.reportedTotal > input.collected
  ) {
    return {
      status: "partial",
      reason: `provider reports ${String(input.reportedTotal)} rows, ${String(input.collected)} collected`,
    };
  }
  return { status: "complete", reason: null };
}

interface DiffItem {
  key: string;
  domain: string;
}

interface DiffResult<T extends DiffItem> {
  added: T[];
  /** Empty unless the snapshot is `complete`. */
  removed: T[];
  retained: T[];
  status: ComparisonStatus;
  /** Why losses were withheld, when they were. */
  lossSuppressionReason: string | null;
}

/**
 * Difference two snapshots.
 *
 * Additions are reported from any usable snapshot: a link we can see is a fact,
 * regardless of how much else we missed. Removals are reported only from a
 * `complete` one, and only after confirmation by the caller.
 */
export function diffSnapshots<T extends DiffItem>(
  previous: readonly T[],
  current: readonly T[],
  quality: SnapshotQuality,
): DiffResult<T> {
  const previousKeys = new Map(previous.map((item) => [item.key, item]));
  const currentKeys = new Set(current.map((item) => item.key));

  const added: T[] = [];
  const retained: T[] = [];
  for (const item of current) {
    if (previousKeys.has(item.key)) retained.push(item);
    else added.push(item);
  }

  if (quality.status !== "complete") {
    return {
      added: quality.status === "not_comparable" ? [] : added,
      removed: [],
      retained,
      status: quality.status,
      lossSuppressionReason:
        quality.reason ?? "snapshot is not complete enough to derive losses",
    };
  }

  const removed = [...previousKeys.values()].filter(
    (item) => !currentKeys.has(item.key),
  );
  return {
    added,
    removed,
    retained,
    status: "complete",
    lossSuppressionReason: null,
  };
}

/**
 * A loss needs two consecutive complete snapshots to agree.
 *
 * Even a complete pass can miss a link the crawler simply did not revisit, so
 * one absence is a candidate and two are a loss. This mirrors the phase-2 rule
 * for ranking drops, and for the same reason: bad news must be right.
 */
export function confirmLosses<T extends DiffItem>(
  candidates: readonly T[],
  previouslyMissingKeys: ReadonlySet<string>,
): { confirmed: T[]; pending: T[] } {
  const confirmed: T[] = [];
  const pending: T[] = [];
  for (const item of candidates) {
    if (previouslyMissingKeys.has(item.key)) confirmed.push(item);
    else pending.push(item);
  }
  return { confirmed, pending };
}

// --- backlink gap -----------------------------------------------------------

type BacklinkGapCategory =
  | "shared"
  | "primary_only"
  | "competitor_only"
  | "multi_competitor_only"
  | "new_opportunity";

interface GapDomainInput {
  normalizedDomain: string;
  domain: string;
  linksPrimary: boolean;
  competitorEntityIds: readonly string[];
  domainRank?: number | null;
  spamScore?: number | null;
  riskClassification?: "low" | "review" | "suspicious" | "high_risk" | null;
}

interface GapDomainResult extends GapDomainInput {
  category: BacklinkGapCategory;
  competitorCount: number;
  /** Null when quality is unknown — an unrated domain is not a zero-value one. */
  opportunityScore: number | null;
}

/** Below this the domain is not worth pursuing regardless of how many link to it. */
const MIN_OPPORTUNITY_RANK = 20;
const MAX_OPPORTUNITY_SPAM = 30;

/**
 * Classify one referring domain against the primary and its competitors.
 *
 * `new_opportunity` is deliberately a *narrowing* of `competitor_only`: it adds
 * quality and risk gates, so a spammy link farm that happens to link three
 * competitors is never presented as something to go and get.
 */
export function classifyBacklinkGap(input: GapDomainInput): GapDomainResult {
  const competitorCount = new Set(input.competitorEntityIds).size;

  const category = ((): BacklinkGapCategory => {
    if (input.linksPrimary)
      return competitorCount > 0 ? "shared" : "primary_only";
    if (competitorCount === 0) {
      // Links neither us nor any competitor: it should not be in this set at
      // all, but classifying it as competitor_only would be a lie.
      return "competitor_only";
    }
    const qualifies =
      typeof input.domainRank === "number" &&
      input.domainRank >= MIN_OPPORTUNITY_RANK &&
      (input.spamScore === null ||
        input.spamScore === undefined ||
        input.spamScore <= MAX_OPPORTUNITY_SPAM) &&
      (input.riskClassification === null ||
        input.riskClassification === undefined ||
        input.riskClassification === "low");
    if (qualifies) return "new_opportunity";
    return competitorCount >= 2 ? "multi_competitor_only" : "competitor_only";
  })();

  return {
    ...input,
    category,
    competitorCount,
    opportunityScore: opportunityScoreFor(input, competitorCount),
  };
}

/**
 * Value of chasing a domain: authority × how many competitors already have it.
 *
 * Null when the rank is unknown. A zero would sort an unrated domain alongside
 * a genuinely worthless one, and those are different statements.
 */
function opportunityScoreFor(
  input: GapDomainInput,
  competitorCount: number,
): number | null {
  if (typeof input.domainRank !== "number") return null;
  if (input.linksPrimary) return null;
  const spamPenalty =
    typeof input.spamScore === "number"
      ? Math.max(0, 1 - input.spamScore / 100)
      : 1;
  const consensus = 1 + Math.min(competitorCount, 4) * 0.25;
  return Math.round(input.domainRank * consensus * spamPenalty * 100) / 100;
}

/**
 * Build the gap set from per-entity referring-domain lists.
 *
 * Domains are matched on their normalized form, so `www.Example.com.` and
 * `example.com` are one domain rather than three.
 */
export function buildBacklinkGap(input: {
  primaryDomains: readonly {
    normalizedDomain: string;
    domain: string;
    domainRank?: number | null;
    spamScore?: number | null;
  }[];
  competitorDomains: readonly {
    entityId: string;
    domains: readonly {
      normalizedDomain: string;
      domain: string;
      domainRank?: number | null;
      spamScore?: number | null;
    }[];
  }[];
  riskByDomain?: ReadonlyMap<
    string,
    "low" | "review" | "suspicious" | "high_risk"
  >;
}): GapDomainResult[] {
  const merged = new Map<
    string,
    {
      domain: string;
      rank: number | null;
      spam: number | null;
      primary: boolean;
      competitors: Set<string>;
    }
  >();

  const upsert = (row: {
    normalizedDomain: string;
    domain: string;
    domainRank?: number | null;
    spamScore?: number | null;
  }) => {
    const existing = merged.get(row.normalizedDomain);
    if (existing) {
      // Keep the best-known quality signals; a null from one source must not
      // erase a real value from another.
      existing.rank = existing.rank ?? row.domainRank ?? null;
      existing.spam = existing.spam ?? row.spamScore ?? null;
      return existing;
    }
    const created = {
      domain: row.domain,
      rank: row.domainRank ?? null,
      spam: row.spamScore ?? null,
      primary: false,
      competitors: new Set<string>(),
    };
    merged.set(row.normalizedDomain, created);
    return created;
  };

  for (const row of input.primaryDomains) upsert(row).primary = true;
  for (const competitor of input.competitorDomains) {
    for (const row of competitor.domains)
      upsert(row).competitors.add(competitor.entityId);
  }

  return [...merged.entries()]
    .map(([normalizedDomain, value]) =>
      classifyBacklinkGap({
        normalizedDomain,
        domain: value.domain,
        linksPrimary: value.primary,
        competitorEntityIds: [...value.competitors],
        domainRank: value.rank,
        spamScore: value.spam,
        riskClassification: input.riskByDomain?.get(normalizedDomain) ?? null,
      }),
    )
    .toSorted(
      (a, b) => (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1),
    );
}
