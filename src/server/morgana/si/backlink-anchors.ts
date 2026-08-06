import {
  anchorIsUrl,
  detectLookalike,
  normalizeAnchor,
} from "./backlink-normalize";

/**
 * Morgana Search Intelligence — phase 3 anchor intelligence.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Deterministic classification, no model. An anchor is short, adversarial text
 * from an untrusted page; the value of classifying it lies in being able to
 * explain *why* a given anchor was flagged, which a classifier cannot do and a
 * rule can.
 *
 * The output is a signal, never a verdict. Every suspicious label is phrased so
 * that a human still has to look.
 */

type AnchorCategory =
  | "brand"
  | "brand_variant"
  | "exact_keyword"
  | "partial_keyword"
  | "url"
  | "generic"
  | "empty"
  | "suspicious"
  | "unknown";

/** Content-free anchors. Their share of the profile is the interesting part. */
const GENERIC = new Set([
  "clicca qui",
  "qui",
  "sito",
  "sito web",
  "website",
  "link",
  "questo link",
  "learn more",
  "read more",
  "click here",
  "here",
  "more",
  "leggi di più",
  "vai al sito",
  "visita",
  "visit",
  "home",
  "homepage",
  "continua",
  "scopri di più",
  "find out more",
  "source",
  "fonte",
  "articolo",
  "article",
]);

/**
 * Terms that turn a brand mention into a credential-harvesting pattern.
 *
 * "CheckSig" on a random blog is ordinary PR. "CheckSig login" or
 * "CheckSig wallet recovery" on a domain we do not own is the shape of a
 * phishing lure, and that is the distinction this list encodes.
 */
const HIGH_RISK_TERMS = [
  "login",
  "log in",
  "signin",
  "sign in",
  "accedi",
  "accesso",
  "support",
  "supporto",
  "assistenza",
  "recovery",
  "recupero",
  "seed",
  "seed phrase",
  "wallet",
  "private key",
  "chiave privata",
  "bonus",
  "airdrop",
  "giveaway",
  "claim",
  "refund",
  "rimborso",
  "verify",
  "verifica",
  "unlock",
  "sblocca",
  "customer service",
  "helpdesk",
  "connect wallet",
  "validate",
  "migration",
];

interface AnchorClassificationInput {
  anchor: string | null;
  /** Brand tokens, lowercase. First is the canonical brand. */
  brandTokens: readonly string[];
  /** Watched keyword texts, lowercase, for exact/partial keyword matching. */
  keywords?: readonly string[];
  /** Normalized root of the domain the link comes FROM. */
  sourceRoot?: string;
  /** Normalized roots we own. A brand anchor from one of these is expected. */
  officialRoots?: readonly string[];
}

interface AnchorClassification {
  category: AnchorCategory;
  normalized: string | null;
  /** Human-readable signal, or null when nothing stood out. */
  suspiciousSignal: string | null;
  /** Machine-readable reasons for the risk model. */
  signals: string[];
}

function containsBrand(
  anchor: string,
  brandTokens: readonly string[],
): string | null {
  for (const token of brandTokens) {
    if (token && anchor.includes(token.toLowerCase())) return token;
  }
  return null;
}

/**
 * The suspicion rules, kept separate from categorisation so that a
 * `brand` anchor can still carry a signal without being relabelled.
 */
function suspicionSignals(
  input: AnchorClassificationInput,
  normalized: string,
): string[] {
  const signals: string[] = [];
  const brand = containsBrand(normalized, input.brandTokens);
  const officialRoots = input.officialRoots ?? [];
  const sourceRoot = input.sourceRoot ?? "";
  const isOfficialSource = officialRoots.some(
    (root) => root && sourceRoot === root,
  );

  if (brand && sourceRoot && !isOfficialSource) {
    const risky = HIGH_RISK_TERMS.filter((term) => normalized.includes(term));
    if (risky.length > 0) {
      // The combination is the signal, not either half on its own.
      signals.push(
        `brand anchor combined with ${risky.slice(0, 3).join(", ")}`,
      );
    }
  }

  // A near-miss of the brand inside the anchor text itself: "chekcsig support".
  for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 4) continue;
    const verdict = detectLookalike(word, input.brandTokens);
    if (verdict.isLookalike && verdict.reason !== "exact_substring") {
      signals.push(`anchor contains a near-variant of the brand ("${word}")`);
      break;
    }
  }

  if (
    brand &&
    sourceRoot &&
    !isOfficialSource &&
    !signals.includes("brand mention on an unrelated domain")
  ) {
    const brandInSource = detectLookalike(sourceRoot, input.brandTokens);
    if (!brandInSource.isLookalike) {
      signals.push("brand anchor on a domain unrelated to the brand");
    }
  }

  return signals;
}

export function classifyAnchor(
  input: AnchorClassificationInput,
): AnchorClassification {
  const normalized = normalizeAnchor(input.anchor);
  if (normalized === null) {
    // No text at all: an image link or a bare href. Real, and not "unknown".
    return {
      category: "empty",
      normalized: null,
      suspiciousSignal: null,
      signals: [],
    };
  }

  const signals = suspicionSignals(input, normalized);
  const brand = containsBrand(normalized, input.brandTokens);

  const category = ((): AnchorCategory => {
    if (signals.length > 0) return "suspicious";
    if (anchorIsUrl(normalized)) return "url";
    if (GENERIC.has(normalized)) return "generic";
    if (brand) {
      // Exactly the brand, versus the brand inside a longer phrase.
      return normalized === brand ? "brand" : "brand_variant";
    }
    const keywords = input.keywords ?? [];
    if (keywords.includes(normalized)) return "exact_keyword";
    if (
      keywords.some(
        (keyword) => keyword.length > 3 && normalized.includes(keyword),
      )
    ) {
      return "partial_keyword";
    }
    return "unknown";
  })();

  return {
    category,
    normalized,
    // Phrased as a signal requiring review, never as an accusation.
    suspiciousSignal:
      signals.length > 0
        ? `possible impersonation signal — ${signals[0]}`
        : null,
    signals,
  };
}

interface AnchorAggregate {
  normalizedAnchor: string;
  anchorText: string | null;
  category: AnchorCategory;
  backlinkCount: number;
  referringDomainCount: number;
  suspiciousSignal: string | null;
}

/**
 * Collapse backlinks into anchor aggregates.
 *
 * Referring domains are counted distinctly, because one domain linking a
 * thousand times with the same anchor is a very different profile from a
 * thousand domains doing it once — and only the second is real authority.
 */
export function aggregateAnchors(
  backlinks: readonly {
    anchorText: string | null;
    normalizedAnchor: string | null;
    normalizedSourceDomain: string;
  }[],
  classify: (anchor: string | null, sourceRoot: string) => AnchorClassification,
): AnchorAggregate[] {
  const byAnchor = new Map<
    string,
    {
      text: string | null;
      domains: Set<string>;
      count: number;
      classification: AnchorClassification;
    }
  >();

  for (const backlink of backlinks) {
    const classification = classify(
      backlink.anchorText,
      backlink.normalizedSourceDomain,
    );
    // Empty anchors group under a reserved key so they are countable without
    // colliding with a literal anchor of that text.
    const key = classification.normalized ?? " empty";
    const existing = byAnchor.get(key);
    if (existing) {
      existing.count += 1;
      existing.domains.add(backlink.normalizedSourceDomain);
      // A single suspicious occurrence makes the whole aggregate worth review.
      if (
        !existing.classification.suspiciousSignal &&
        classification.suspiciousSignal
      ) {
        existing.classification = classification;
      }
    } else {
      byAnchor.set(key, {
        text: backlink.anchorText,
        domains: new Set([backlink.normalizedSourceDomain]),
        count: 1,
        classification,
      });
    }
  }

  return [...byAnchor.entries()]
    .map(([key, value]) => ({
      normalizedAnchor: key,
      anchorText: value.text,
      category: value.classification.category,
      backlinkCount: value.count,
      referringDomainCount: value.domains.size,
      suspiciousSignal: value.classification.suspiciousSignal,
    }))
    .toSorted(
      (a, b) =>
        b.referringDomainCount - a.referringDomainCount ||
        b.backlinkCount - a.backlinkCount,
    );
}
