/**
 * Morgana Search Intelligence — phase 4 correlation logic.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P9).
 *
 * Campaign detection, competitor momentum and reputation correlation. All
 * deterministic and all pure: no store import, no model, no LLM. Correlation
 * that cannot be explained to the analyst who has to act on it is worse than no
 * correlation, and a rule can explain itself where a classifier cannot.
 *
 * The rule that governs the whole file: **independent families, not independent
 * signals.** Three readings of the same underlying fact are one observation
 * seen three times, and treating them as three is how a correlation engine
 * starts manufacturing confidence it has not earned.
 */

export type CampaignCategory =
  | "brand_campaign"
  | "competitor_campaign"
  | "content_campaign"
  | "link_building_campaign"
  | "possible_impersonation_campaign"
  | "unknown_campaign";

export type SignalType =
  | "mention_surge"
  | "new_pages"
  | "new_keywords"
  | "ranking_gains"
  | "new_backlinks"
  | "new_referring_domains"
  | "new_landing_pages"
  | "social_spike"
  | "coordinated_anchors"
  | "linked_domains";

/**
 * Which family each signal belongs to.
 *
 * "New pages" and "new landing pages" are the same observation at different
 * granularity; counting them separately would let one content push look like
 * two independent confirmations.
 */
const SIGNAL_FAMILY: Record<SignalType, string> = {
  mention_surge: "attention",
  social_spike: "attention",
  new_pages: "content",
  new_landing_pages: "content",
  new_keywords: "search",
  ranking_gains: "search",
  new_backlinks: "links",
  new_referring_domains: "links",
  coordinated_anchors: "coordination",
  linked_domains: "coordination",
};

export function familyOf(signal: SignalType): string {
  return SIGNAL_FAMILY[signal];
}

export interface Signal {
  type: SignalType;
  /** Null when the size is genuinely unknown; never a stand-in zero. */
  magnitude: number | null;
  observedAt: string;
  reason: string;
}

export interface CampaignCandidate {
  category: CampaignCategory;
  subjectLabel: string;
  subjectEntityId: string | null;
  signals: Signal[];
  families: string[];
  startAt: string;
  lastActivityAt: string;
  confidence: number | null;
  windowDays: number;
}

/** Three coherent signals in one window. Two is a coincidence. */
export const MIN_CAMPAIGN_SIGNALS = 3;
const DEFAULT_WINDOW_DAYS = 7;

/**
 * Pick the category from the signal mix.
 *
 * Ordered by specificity: coordination beats links, links beat content. An
 * impersonation campaign is called that whenever coordination signals are
 * present alongside anything else, because that is the reading that costs the
 * most to miss.
 */
function categorise(
  signals: readonly Signal[],
  subjectIsCompetitor: boolean,
): CampaignCategory {
  const types = new Set(signals.map((signal) => signal.type));
  const coordination =
    types.has("coordinated_anchors") || types.has("linked_domains");
  const links =
    types.has("new_backlinks") || types.has("new_referring_domains");
  const content = types.has("new_pages") || types.has("new_landing_pages");

  if (coordination) return "possible_impersonation_campaign";
  if (subjectIsCompetitor) return "competitor_campaign";
  if (links && !content) return "link_building_campaign";
  if (content) return "content_campaign";
  if (types.has("mention_surge") || types.has("social_spike"))
    return "brand_campaign";
  return "unknown_campaign";
}

/**
 * Confidence from breadth, not from volume.
 *
 * Five signals from one family say much less than three from three families,
 * so the family count is what drives this. Null below the threshold, because
 * "not a campaign" is not "a campaign we are unsure about".
 */
function campaignConfidence(
  families: readonly string[],
  signalCount: number,
): number | null {
  if (signalCount < MIN_CAMPAIGN_SIGNALS) return null;
  // The step is small enough that the ceiling is only reached at five families,
  // so a broader campaign always reads as more confident than a narrower one
  // instead of both flattening against the cap.
  const base = Math.min(0.4 + families.length * 0.12, 0.95);
  return Math.round(base * 100) / 100;
}

interface DetectCampaignInput {
  subjectLabel: string;
  subjectEntityId: string | null;
  subjectIsCompetitor: boolean;
  signals: readonly Signal[];
  windowDays?: number;
  now?: Date;
}

/**
 * Build a campaign candidate, or nothing.
 *
 * Returns null far more often than not, and that is the point: the value of
 * this detector is in what it stays quiet about.
 */
export function detectCampaign(
  input: DetectCampaignInput,
): CampaignCandidate | null {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - windowDays * 86_400_000;

  const inWindow = input.signals.filter((signal) => {
    const at = new Date(signal.observedAt).getTime();
    return Number.isFinite(at) && at >= cutoff && at <= now.getTime();
  });
  if (inWindow.length < MIN_CAMPAIGN_SIGNALS) return null;

  // Deduplicated by type: the same signal reported twice is one signal.
  const byType = new Map<SignalType, Signal>();
  for (const signal of inWindow) {
    const existing = byType.get(signal.type);
    if (!existing || signal.observedAt > existing.observedAt)
      byType.set(signal.type, signal);
  }
  const signals = [...byType.values()];
  if (signals.length < MIN_CAMPAIGN_SIGNALS) return null;

  const families = [...new Set(signals.map((signal) => familyOf(signal.type)))];
  // Three signals from one family is one story told three ways, not a campaign.
  if (families.length < 2) return null;

  const timestamps = signals.map((signal) => signal.observedAt).toSorted();
  return {
    category: categorise(signals, input.subjectIsCompetitor),
    subjectLabel: input.subjectLabel,
    subjectEntityId: input.subjectEntityId,
    signals: signals.toSorted((a, b) =>
      a.observedAt.localeCompare(b.observedAt),
    ),
    families,
    startAt: timestamps[0] ?? now.toISOString(),
    lastActivityAt: timestamps.at(-1) ?? now.toISOString(),
    confidence: campaignConfidence(families, signals.length),
    windowDays,
  };
}

// --- competitor momentum ----------------------------------------------------

export type MomentumState =
  | "declining"
  | "stable"
  | "growing"
  | "accelerating"
  | "insufficient_data";

export interface MomentumComponent {
  name: string;
  /** Null means unmeasured. It contributes nothing rather than counting as 0. */
  delta: number | null;
  direction: "up" | "down" | "flat" | "unknown";
  reason: string;
}

export interface MomentumResult {
  state: MomentumState;
  components: MomentumComponent[];
  /** How many components had a usable reading. */
  measured: number;
  /** Null when there is not enough to state one. */
  score: number | null;
}

interface MomentumInput {
  mentionTrend?: number | null;
  sentimentTrend?: number | null;
  visibilityTrend?: number | null;
  rankGains?: number | null;
  newKeywords?: number | null;
  backlinkGrowth?: number | null;
  newReferringDomains?: number | null;
  activeCampaigns?: number | null;
}

/**
 * The component order, written out.
 *
 * `Object.keys` on a `Record<K, V>` returns `string[]`, so walking the label
 * table that way needs a cast. Listing the keys states the display order
 * explicitly, which is something the caller cares about anyway.
 */
const MOMENTUM_KEYS = [
  "mentionTrend",
  "sentimentTrend",
  "visibilityTrend",
  "rankGains",
  "newKeywords",
  "backlinkGrowth",
  "newReferringDomains",
  "activeCampaigns",
] as const satisfies readonly (keyof MomentumInput)[];

const MOMENTUM_LABELS: Record<keyof MomentumInput, string> = {
  mentionTrend: "andamento mention",
  sentimentTrend: "andamento sentiment",
  visibilityTrend: "visibilità organica",
  rankGains: "posizioni guadagnate",
  newKeywords: "nuove keyword",
  backlinkGrowth: "crescita backlink",
  newReferringDomains: "nuovi domini referenti",
  activeCampaigns: "campagne attive",
};

/** At least this many components must be measurable to state a direction. */
const MIN_MEASURED_COMPONENTS = 3;

/**
 * Explainable momentum.
 *
 * There is no opaque score: the state is derived from the components, and all
 * of them — including the ones that could not be measured — are returned so the
 * UI can show its work.
 *
 * A null input is unmeasured, never zero. A competitor whose sentiment we have
 * never sampled is not a competitor with flat sentiment, and averaging the
 * missing value in as 0 would drag every state toward "stable".
 */
export function computeMomentum(input: MomentumInput): MomentumResult {
  const components: MomentumComponent[] = [];
  for (const key of MOMENTUM_KEYS) {
    const label = MOMENTUM_LABELS[key];
    const value = input[key];
    if (value === null || value === undefined) {
      components.push({
        name: label,
        delta: null,
        direction: "unknown",
        reason: "dato non disponibile",
      });
      continue;
    }
    const direction = value > 0.02 ? "up" : value < -0.02 ? "down" : "flat";
    components.push({
      name: label,
      delta: value,
      direction,
      reason:
        direction === "up"
          ? "in crescita nel periodo"
          : direction === "down"
            ? "in calo nel periodo"
            : "sostanzialmente invariato",
    });
  }

  const measured = components.filter((component) => component.delta !== null);
  if (measured.length < MIN_MEASURED_COMPONENTS) {
    return {
      state: "insufficient_data",
      components,
      measured: measured.length,
      score: null,
    };
  }

  const score =
    measured.reduce((total, component) => total + (component.delta ?? 0), 0) /
    measured.length;
  const rising = measured.filter(
    (component) => component.direction === "up",
  ).length;

  const state: MomentumState =
    score > 0.15 && rising >= 3
      ? "accelerating"
      : score > 0.03
        ? "growing"
        : score < -0.05
          ? "declining"
          : "stable";

  return {
    state,
    components,
    measured: measured.length,
    score: Math.round(score * 1000) / 1000,
  };
}

// --- reputation correlation -------------------------------------------------

export type ReputationCategory =
  | "negative_content_rising"
  | "brand_confusion"
  | "possible_impersonation"
  | "coordinated_negative_mentions"
  | "suspicious_domain_campaign"
  | "competitor_reputation_event";

export type Severity = "low" | "medium" | "high" | "critical";

export interface ReputationSignal {
  type: string;
  family: string;
  reason: string;
  weight: number;
  observedAt: string;
}

export interface ReputationResult {
  category: ReputationCategory;
  severity: Severity;
  confidence: number | null;
  signals: ReputationSignal[];
  independentFamilies: number;
  channel: "intel" | "brand_protection" | "security" | "none";
}

/** Reputation findings need at least two independent families to exist at all. */
const MIN_REPUTATION_FAMILIES = 2;

function severityFor(weight: number, families: number): Severity {
  if (weight >= 70 && families >= 3) return "critical";
  if (weight >= 50 && families >= 2) return "high";
  if (weight >= 30) return "medium";
  return "low";
}

/**
 * Route a reputation finding.
 *
 * The security channel is deliberately the hardest to reach: high severity or
 * above AND two independent families. One loud signal must never be able to
 * page security on its own, and a channel that fires on ordinary SEO movement
 * stops being read long before the day it matters.
 */
function routeReputation(
  category: ReputationCategory,
  severity: Severity,
  families: number,
): ReputationResult["channel"] {
  const impersonation =
    category === "possible_impersonation" ||
    category === "suspicious_domain_campaign";
  if (
    impersonation &&
    (severity === "critical" || severity === "high") &&
    families >= 2
  ) {
    return "security";
  }
  if (
    impersonation ||
    category === "brand_confusion" ||
    category === "coordinated_negative_mentions"
  ) {
    return "brand_protection";
  }
  if (severity === "low") return "none";
  return "intel";
}

interface CorrelateReputationInput {
  category: ReputationCategory;
  signals: readonly ReputationSignal[];
}

/**
 * Correlate reputation signals into a finding, or nothing.
 *
 * Returns null when fewer than two independent families fired. A single
 * negative article is content, not an incident; it becomes an incident when
 * something unrelated agrees with it.
 */
export function correlateReputation(
  input: CorrelateReputationInput,
): ReputationResult | null {
  if (input.signals.length === 0) return null;
  const families = [...new Set(input.signals.map((signal) => signal.family))];
  if (families.length < MIN_REPUTATION_FAMILIES) return null;

  const weight = Math.min(
    100,
    input.signals.reduce((total, signal) => total + signal.weight, 0),
  );
  const severity = severityFor(weight, families.length);

  return {
    category: input.category,
    severity,
    // Breadth again: three families agreeing is worth more than three
    // restatements of one.
    confidence:
      Math.round(Math.min(0.95, 0.4 + families.length * 0.15) * 100) / 100,
    signals: input.signals.toSorted((a, b) => b.weight - a.weight),
    independentFamilies: families.length,
    channel: routeReputation(input.category, severity, families.length),
  };
}

/**
 * Escalate a phase-3 impersonation finding with phase-4 correlation.
 *
 * The backlink risk score already says the domain looks wrong. This adds only
 * what phase 3 could not see: that the same domain also shows up in mentions,
 * on Telegram, or in search results. Correlation may raise the reading; it
 * never lowers it, because the phase-3 evidence has not gone away.
 */
export function escalateImpersonation(input: {
  baseRiskScore: number;
  baseFamilies: number;
  mentionCount?: number | null;
  telegramCount?: number | null;
  socialCount?: number | null;
  rankingPresence?: boolean | null;
  backlinkActivity?: number | null;
}): { score: number; families: number; signals: ReputationSignal[] } {
  const signals: ReputationSignal[] = [];
  const at = new Date().toISOString();
  let score = input.baseRiskScore;
  let families = input.baseFamilies;

  const add = (
    weight: number,
    type: string,
    family: string,
    reason: string,
  ) => {
    signals.push({ type, family, reason, weight, observedAt: at });
    score = Math.min(100, score + weight);
    families += 1;
  };

  if ((input.telegramCount ?? 0) > 0) {
    add(
      15,
      "telegram_presence",
      "telegram",
      "il dominio compare in messaggi Telegram monitorati",
    );
  }
  if ((input.socialCount ?? 0) > 0) {
    add(
      10,
      "social_presence",
      "social",
      "il dominio compare in post social monitorati",
    );
  }
  if ((input.mentionCount ?? 0) > 0) {
    add(
      10,
      "mention_presence",
      "mentions",
      "il dominio compare in mention monitorate",
    );
  }
  if (input.rankingPresence === true) {
    add(
      10,
      "ranking_presence",
      "search",
      "il dominio si posiziona su keyword monitorate",
    );
  }
  if ((input.backlinkActivity ?? 0) >= 5) {
    add(
      10,
      "backlink_activity",
      "links",
      "attività di link building anomala dal dominio",
    );
  }

  return { score, families, signals };
}
