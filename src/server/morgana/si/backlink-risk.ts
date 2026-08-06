import { detectLookalike, isSuspiciousTld } from "./backlink-normalize";

/**
 * Morgana Search Intelligence — phase 3 risk scoring.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * A deterministic, additive, fully explainable 0–100 score. Every component
 * contributes a weight, a reason and its evidence, and the UI renders all three
 * — because the score's job is to order an analyst's queue, not to decide
 * anything on its own.
 *
 * Explicitly NOT proof of fraud. The classification bands are named for the
 * action they imply (`review`, `suspicious`) rather than for a conclusion.
 */

export type RiskClassification = "low" | "review" | "suspicious" | "high_risk";

type RiskComponent =
  | "brand_in_domain"
  | "brand_in_anchor"
  | "lookalike_domain"
  | "suspicious_tld"
  | "recent_first_seen"
  | "low_domain_rank"
  | "high_spam_score"
  | "suspicious_anchor_terms"
  | "target_mismatch"
  | "unusual_growth"
  | "known_brand_mention"
  | "telegram_or_social_signal";

export interface RiskReason {
  component: RiskComponent;
  weight: number;
  reason: string;
  evidence: string;
}

interface RiskInput {
  normalizedDomain: string;
  domainRoot: string;
  tld: string | null;
  /** Lowercase brand tokens; the first is canonical. */
  brandTokens: readonly string[];
  /** Normalized roots we own — a link from one of these is never suspicious. */
  officialRoots?: readonly string[];
  anchors?: readonly string[];
  /** Machine-readable signals from the anchor classifier. */
  anchorSignals?: readonly string[];
  domainRank?: number | null;
  spamScore?: number | null;
  firstSeenAt?: string | null;
  /** Backlinks added by this domain in the most recent window. */
  recentBacklinkGrowth?: number | null;
  /** Do the links point at URLs on our own domains? */
  targetsOwnedDomain?: boolean | null;
  /** Aggregated Morgana brand-protection signals for this domain. */
  brandProtection?: {
    mentionCount?: number;
    telegramMentionCount?: number;
    socialMentionCount?: number;
    negativeSentimentCount?: number;
    existingImpersonationFindings?: number;
  } | null;
  now?: Date;
}

export interface RiskResult {
  score: number;
  classification: RiskClassification;
  reasons: RiskReason[];
  /**
   * How many *independent* signal families fired. The security channel needs
   * two, so this is what gates the loudest alert.
   */
  independentSignals: number;
}

/**
 * Component weights.
 *
 * Chosen so that no single component can reach `high_risk` alone: the top
 * weight is 30 and the band starts at 75. A domain has to look wrong in
 * several unrelated ways before it is treated as a serious finding.
 */
const WEIGHTS: Record<RiskComponent, number> = {
  lookalike_domain: 30,
  brand_in_domain: 25,
  telegram_or_social_signal: 20,
  brand_in_anchor: 15,
  suspicious_anchor_terms: 20,
  high_spam_score: 15,
  suspicious_tld: 10,
  recent_first_seen: 10,
  known_brand_mention: 10,
  target_mismatch: 10,
  unusual_growth: 10,
  low_domain_rank: 5,
};

/**
 * Signal families for the independence count.
 *
 * A lookalike domain and a brand-in-domain hit are the *same* observation seen
 * twice; counting them as two would let one fact unlock the security channel.
 */
const FAMILY: Record<RiskComponent, string> = {
  lookalike_domain: "identity",
  brand_in_domain: "identity",
  brand_in_anchor: "anchor",
  suspicious_anchor_terms: "anchor",
  suspicious_tld: "registration",
  recent_first_seen: "registration",
  low_domain_rank: "quality",
  high_spam_score: "quality",
  target_mismatch: "targeting",
  unusual_growth: "behaviour",
  known_brand_mention: "morgana_correlation",
  telegram_or_social_signal: "morgana_correlation",
};

const DAY_MS = 86_400_000;

export function classifyRisk(score: number): RiskClassification {
  if (score >= 75) return "high_risk";
  if (score >= 50) return "suspicious";
  if (score >= 25) return "review";
  return "low";
}

function push(
  reasons: RiskReason[],
  component: RiskComponent,
  reason: string,
  evidence: string,
): void {
  reasons.push({ component, weight: WEIGHTS[component], reason, evidence });
}

function identitySignals(input: RiskInput, reasons: RiskReason[]): void {
  const label = input.domainRoot.split(".")[0] ?? input.domainRoot;
  const verdict = detectLookalike(input.domainRoot, input.brandTokens);
  if (!verdict.isLookalike) return;

  if (verdict.reason === "exact_substring") {
    push(
      reasons,
      "brand_in_domain",
      "the hostname contains the brand name",
      `hostname label "${label}"`,
    );
  } else {
    push(
      reasons,
      "lookalike_domain",
      verdict.reason === "confusable_fold"
        ? "the hostname matches the brand once look-alike characters are folded"
        : `the hostname is within ${String(verdict.distance)} edits of the brand`,
      `hostname label "${label}"`,
    );
  }
}

function anchorRiskSignals(input: RiskInput, reasons: RiskReason[]): void {
  const anchors = input.anchors ?? [];
  const brandAnchor = anchors.find((anchor) =>
    input.brandTokens.some((token) => token && anchor.includes(token)),
  );
  if (brandAnchor) {
    push(
      reasons,
      "brand_in_anchor",
      "links to us using the brand as anchor text",
      `anchor "${brandAnchor}"`,
    );
  }
  const signals = input.anchorSignals ?? [];
  if (signals.length > 0) {
    push(
      reasons,
      "suspicious_anchor_terms",
      signals[0] ?? "anchor pattern flagged",
      signals.slice(0, 2).join("; "),
    );
  }
}

function qualitySignals(input: RiskInput, reasons: RiskReason[]): void {
  // A null spam score is unknown, not clean — so it contributes nothing at all
  // rather than being read as zero.
  if (typeof input.spamScore === "number" && input.spamScore >= 60) {
    push(
      reasons,
      "high_spam_score",
      "the provider reports a high spam score",
      `spam score ${String(input.spamScore)}`,
    );
  }
  if (typeof input.domainRank === "number" && input.domainRank <= 10) {
    push(
      reasons,
      "low_domain_rank",
      "the domain has almost no authority",
      `domain rank ${String(input.domainRank)}`,
    );
  }
  if (isSuspiciousTld(input.tld)) {
    push(
      reasons,
      "suspicious_tld",
      "registered under a suffix common in throwaway registrations",
      `.${input.tld ?? ""}`,
    );
  }
}

function behaviourSignals(input: RiskInput, reasons: RiskReason[]): void {
  const now = input.now ?? new Date();
  if (input.firstSeenAt) {
    const age = now.getTime() - new Date(input.firstSeenAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < 30 * DAY_MS) {
      push(
        reasons,
        "recent_first_seen",
        "first observed in the last 30 days",
        `first seen ${input.firstSeenAt}`,
      );
    }
  }
  if (
    typeof input.recentBacklinkGrowth === "number" &&
    input.recentBacklinkGrowth >= 25
  ) {
    push(
      reasons,
      "unusual_growth",
      "added an unusual number of links in a short window",
      `${String(input.recentBacklinkGrowth)} new links`,
    );
  }
  if (input.targetsOwnedDomain === false) {
    push(
      reasons,
      "target_mismatch",
      "uses our brand but points somewhere we do not own",
      "target outside the official asset list",
    );
  }
}

function correlationSignals(input: RiskInput, reasons: RiskReason[]): void {
  const bp = input.brandProtection;
  if (!bp) return;
  const telegram = bp.telegramMentionCount ?? 0;
  const social = bp.socialMentionCount ?? 0;
  const findings = bp.existingImpersonationFindings ?? 0;
  if (telegram + social + findings > 0) {
    push(
      reasons,
      "telegram_or_social_signal",
      "this domain already appears in Morgana brand-protection data",
      `telegram ${String(telegram)}, social ${String(social)}, findings ${String(findings)}`,
    );
  }
  const mentions = bp.mentionCount ?? 0;
  if (mentions > 0) {
    push(
      reasons,
      "known_brand_mention",
      "this domain has been seen in monitored brand mentions",
      `${String(mentions)} mentions${bp.negativeSentimentCount ? `, ${String(bp.negativeSentimentCount)} negative` : ""}`,
    );
  }
}

/**
 * Score one referring domain.
 *
 * A domain we own scores zero with an empty reason list — no amount of brand
 * in the hostname makes our own site suspicious, and that check has to come
 * first or every official link would be flagged.
 */
export function scoreBacklinkRisk(input: RiskInput): RiskResult {
  const officialRoots = input.officialRoots ?? [];
  if (officialRoots.some((root) => root && input.domainRoot === root)) {
    return {
      score: 0,
      classification: "low",
      reasons: [],
      independentSignals: 0,
    };
  }

  const reasons: RiskReason[] = [];
  identitySignals(input, reasons);
  anchorRiskSignals(input, reasons);
  qualitySignals(input, reasons);
  behaviourSignals(input, reasons);
  correlationSignals(input, reasons);

  const score = Math.min(
    100,
    reasons.reduce((total, reason) => total + reason.weight, 0),
  );
  const families = new Set(reasons.map((reason) => FAMILY[reason.component]));

  return {
    score,
    classification: classifyRisk(score),
    // Ordered by weight so the UI leads with the reason that mattered most.
    reasons: reasons.toSorted((a, b) => b.weight - a.weight),
    independentSignals: families.size,
  };
}

/**
 * Which Slack surface, if any, an assessment belongs on.
 *
 * The security channel is deliberately hard to reach: `high_risk` AND at least
 * two independent signal families. One loud component must never be able to
 * page the security channel on its own.
 */
export function routeRisk(
  result: RiskResult,
): "security" | "brand_protection" | "intel" | "none" {
  if (result.classification === "high_risk" && result.independentSignals >= 2)
    return "security";
  if (
    result.classification === "high_risk" ||
    result.classification === "suspicious"
  ) {
    return "brand_protection";
  }
  if (result.classification === "review") return "intel";
  return "none";
}
