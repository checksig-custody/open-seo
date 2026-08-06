/**
 * Morgana Search Intelligence — AI Visibility metrics.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Pure metric arithmetic. No provider, no database, no AI: nothing in this
 * subsystem sends a prompt to a language model. What it reads is what the SERP
 * provider already reports about AI answers — the same DataForSEO surface
 * upstream's Brand Lookup uses — and what it produces are counts and shares.
 *
 * Three distinctions are load-bearing and never collapse:
 *
 * - **mentioned**: the brand's name appears in the AI answer;
 * - **cited**: a page on the brand's domain is listed as a source;
 * - **organic presence**: the brand ranks in the ordinary results.
 *
 * They are different facts with different worth, and a metric that merged them
 * would let a passing name-drop read as an endorsement. Nothing here is called
 * "AI accuracy": we observe whether we were cited, not whether the answer was
 * right about us — that would be a claim about the model's output quality that
 * this data cannot support.
 */

export interface SnapshotFacts {
  queryId: string;
  priority: "critical" | "high" | "normal" | "low";
  aiResultPresent: boolean | null;
  primaryBrandMentioned: boolean | null;
  primaryBrandCited: boolean | null;
  competitorMentions: number | null;
  competitorCitations: number | null;
  citedDomainCount: number | null;
  checkedAt: string;
}

export interface CitationFacts {
  queryId: string;
  normalizedDomain: string;
  entityId: string | null;
  citationOrder: number;
}

export interface AiVisibilityMetrics {
  queriesTracked: number;
  queriesObserved: number;
  /** Null when nothing was observed — a share of nothing is not zero. */
  queriesWithAiResult: number | null;
  queriesWithBrandMention: number | null;
  queriesWithBrandCitation: number | null;
  /** Our citations over all citations we saw. Null below the coverage floor. */
  citationShare: number | null;
  citationShareStatus: "ok" | "insufficient_coverage" | "not_observed";
  competitorMentionShare: number | null;
  competitorCitationShare: number | null;
  topCitedDomains: { domain: string; citations: number; isOurs: boolean }[];
}

/**
 * Coverage floor.
 *
 * Below this share of the watchlist actually observed, a citation share is
 * arithmetic over a sample that does not represent the list — the same refusal
 * phase 2's Share of Search makes for the same reason.
 */
const COVERAGE_FLOOR = 0.5;

export function computeMetrics(
  snapshots: readonly SnapshotFacts[],
  citations: readonly CitationFacts[],
  queriesTracked: number,
): AiVisibilityMetrics {
  const observed = snapshots.filter(
    (snapshot) => snapshot.aiResultPresent !== null,
  );
  if (observed.length === 0) {
    return {
      queriesTracked,
      queriesObserved: 0,
      queriesWithAiResult: null,
      queriesWithBrandMention: null,
      queriesWithBrandCitation: null,
      citationShare: null,
      citationShareStatus: "not_observed",
      competitorMentionShare: null,
      competitorCitationShare: null,
      topCitedDomains: [],
    };
  }

  const withAi = observed.filter(
    (snapshot) => snapshot.aiResultPresent === true,
  );
  const mentioned = observed.filter(
    (snapshot) => snapshot.primaryBrandMentioned === true,
  ).length;
  const cited = observed.filter(
    (snapshot) => snapshot.primaryBrandCited === true,
  ).length;

  const byDomain = new Map<string, { citations: number; isOurs: boolean }>();
  for (const citation of citations) {
    const current = byDomain.get(citation.normalizedDomain) ?? {
      citations: 0,
      isOurs: false,
    };
    current.citations += 1;
    current.isOurs = current.isOurs || citation.entityId !== null;
    byDomain.set(citation.normalizedDomain, current);
  }

  const totalCitations = citations.length;
  const ourCitations = citations.filter(
    (citation) => citation.entityId !== null,
  ).length;

  const coverage = queriesTracked === 0 ? 0 : observed.length / queriesTracked;
  const citationShareStatus =
    coverage < COVERAGE_FLOOR ? "insufficient_coverage" : "ok";

  const competitorMentionTotal = observed.reduce(
    (sum, snapshot) => sum + (snapshot.competitorMentions ?? 0),
    0,
  );
  const competitorCitationTotal = observed.reduce(
    (sum, snapshot) => sum + (snapshot.competitorCitations ?? 0),
    0,
  );

  return {
    queriesTracked,
    queriesObserved: observed.length,
    queriesWithAiResult: withAi.length,
    queriesWithBrandMention: mentioned,
    queriesWithBrandCitation: cited,
    citationShare:
      citationShareStatus === "ok" && totalCitations > 0
        ? ourCitations / totalCitations
        : null,
    citationShareStatus:
      totalCitations === 0 ? "not_observed" : citationShareStatus,
    competitorMentionShare:
      mentioned + competitorMentionTotal === 0
        ? null
        : competitorMentionTotal / (mentioned + competitorMentionTotal),
    competitorCitationShare:
      ourCitations + competitorCitationTotal === 0
        ? null
        : competitorCitationTotal / (ourCitations + competitorCitationTotal),
    topCitedDomains: [...byDomain.entries()]
      .map(([domain, value]) => ({ domain, ...value }))
      .toSorted((a, b) => b.citations - a.citations)
      .slice(0, 20),
  };
}

interface CitationDelta {
  gained: { domain: string; queryId: string; isOurs: boolean }[];
  lost: { domain: string; queryId: string; isOurs: boolean }[];
}

/**
 * What changed between two observations of the same query.
 *
 * Comparing per query rather than in aggregate: a citation we lost on one
 * question and gained on another is two events, and the aggregate would show
 * neither.
 */
/** A citation's identity: the query it answered plus the domain cited. */
function citationKey(citation: CitationFacts): string {
  return `${citation.queryId}|${citation.normalizedDomain}`;
}

export function citationDelta(
  current: readonly CitationFacts[],
  previous: readonly CitationFacts[],
): CitationDelta {
  const key = citationKey;
  const before = new Map(previous.map((citation) => [key(citation), citation]));
  const after = new Map(current.map((citation) => [key(citation), citation]));

  const gained: CitationDelta["gained"] = [];
  const lost: CitationDelta["lost"] = [];
  for (const [entryKey, citation] of after) {
    if (!before.has(entryKey)) {
      gained.push({
        domain: citation.normalizedDomain,
        queryId: citation.queryId,
        isOurs: citation.entityId !== null,
      });
    }
  }
  for (const [entryKey, citation] of before) {
    if (!after.has(entryKey)) {
      lost.push({
        domain: citation.normalizedDomain,
        queryId: citation.queryId,
        isOurs: citation.entityId !== null,
      });
    }
  }
  return { gained, lost };
}

type AiEventType =
  | "citation_gained"
  | "citation_lost"
  | "competitor_citation_gained"
  | "competitor_citation_lost"
  | "ai_result_appeared"
  | "ai_result_disappeared"
  | "suspicious_domain_cited"
  | "citation_share_change";

interface AiEvent {
  queryId: string;
  eventType: AiEventType;
  severity: "info" | "notice" | "warning" | "critical";
  domain: string | null;
  magnitude: number | null;
  reason: string;
  channel: "intel" | "brand_protection" | "security" | "none";
}

interface EventInput {
  queryId: string;
  priority: "critical" | "high" | "normal" | "low";
  current: SnapshotFacts | null;
  previous: SnapshotFacts | null;
  delta: CitationDelta;
  /** Domains phases 3–4 already flagged. Routing depends on this, not on text. */
  suspiciousDomains: ReadonlySet<string>;
  citationShareChange: number | null;
}

const CITATION_SHARE_ALERT_THRESHOLD = 0.15;

/**
 * Which observations are worth telling someone about.
 *
 * Deliberately narrow. Losing a citation on a `normal` query is data; losing
 * one on a `critical` query is news. The difference between the two is the
 * only thing keeping this channel readable.
 */
export function detectAiEvents(input: EventInput): AiEvent[] {
  const events: AiEvent[] = [];
  const isCritical = input.priority === "critical";

  for (const entry of input.delta.gained) {
    if (input.suspiciousDomains.has(entry.domain)) {
      // A domain phases 3–4 already flagged, now being cited as a source by an
      // AI answer. That is a brand-protection fact, not an SEO one.
      events.push({
        queryId: input.queryId,
        eventType: "suspicious_domain_cited",
        severity: "critical",
        domain: entry.domain,
        magnitude: null,
        reason: `${entry.domain} is cited as a source and is already flagged by brand protection`,
        channel: "brand_protection",
      });
      continue;
    }
    if (entry.isOurs) {
      events.push({
        queryId: input.queryId,
        eventType: "citation_gained",
        severity: "info",
        domain: entry.domain,
        magnitude: null,
        reason: "our domain became a cited source for this query",
        channel: "intel",
      });
    } else if (isCritical) {
      events.push({
        queryId: input.queryId,
        eventType: "competitor_citation_gained",
        severity: "warning",
        domain: entry.domain,
        magnitude: null,
        reason: `${entry.domain} became a cited source on a critical query`,
        channel: "intel",
      });
    }
  }

  for (const entry of input.delta.lost) {
    if (entry.isOurs && isCritical) {
      events.push({
        queryId: input.queryId,
        eventType: "citation_lost",
        severity: "warning",
        domain: entry.domain,
        magnitude: null,
        reason: "we are no longer cited as a source on a critical query",
        channel: "intel",
      });
    } else if (entry.isOurs) {
      events.push({
        queryId: input.queryId,
        eventType: "citation_lost",
        severity: "info",
        domain: entry.domain,
        magnitude: null,
        reason: "we are no longer cited as a source for this query",
        channel: "none",
      });
    }
  }

  // An AI answer appearing or disappearing changes what the whole query means,
  // but only on a critical question is it worth interrupting someone for.
  if (
    input.current?.aiResultPresent === true &&
    input.previous?.aiResultPresent === false &&
    isCritical
  ) {
    events.push({
      queryId: input.queryId,
      eventType: "ai_result_appeared",
      severity: "notice",
      domain: null,
      magnitude: null,
      reason: "an AI answer now appears for a critical query",
      channel: "intel",
    });
  }
  if (
    input.current?.aiResultPresent === false &&
    input.previous?.aiResultPresent === true &&
    isCritical
  ) {
    events.push({
      queryId: input.queryId,
      eventType: "ai_result_disappeared",
      severity: "info",
      domain: null,
      magnitude: null,
      reason: "the AI answer for a critical query is gone",
      channel: "intel",
    });
  }

  if (
    input.citationShareChange !== null &&
    Math.abs(input.citationShareChange) >= CITATION_SHARE_ALERT_THRESHOLD
  ) {
    events.push({
      queryId: input.queryId,
      eventType: "citation_share_change",
      severity: input.citationShareChange < 0 ? "warning" : "info",
      domain: null,
      magnitude: input.citationShareChange,
      reason: `citation share moved by ${(input.citationShareChange * 100).toFixed(1)} points`,
      channel: "intel",
    });
  }

  return events;
}

/** Lowercased, www-stripped, path-free. The join key to entities and the graph. */
export function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//, "");
  const host = withoutScheme.split("/")[0]?.split("?")[0]?.split("#")[0] ?? "";
  return host
    .replace(/^www\./, "")
    .replace(/\.$/, "")
    .replace(/:\d+$/, "");
}

export function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 300);
}
