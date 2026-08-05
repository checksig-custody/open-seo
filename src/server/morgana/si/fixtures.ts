/**
 * Morgana Search Intelligence — deterministic fixture provider.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Phase 1 ships without a DataForSEO credential for Search Intelligence, and
 * DataForSEO has no usable sandbox (`API_BASE` is a hardcoded constant and the
 * sandbox would need credentials anyway). This provider stands in so the whole
 * pipeline — collector, snapshots, deltas, comparison, UI, export — can be
 * built and exercised end to end without spending anything.
 *
 * Two properties matter:
 *  1. **Deterministic.** Values derive from a hash of the domain and date, so a
 *     test asserts a stable number and a UI screenshot does not churn.
 *  2. **Unmistakable.** Every snapshot it produces is stored with
 *     `source: "fixture"`, and the API refuses to serve fixture data when paid
 *     calls are enabled. Fixture data must never be mistaken for measurement.
 */

interface FixtureOverview {
  organicTrafficEstimate: number | null;
  organicKeywordCount: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  rankSignal: number | null;
}

interface FixtureKeyword {
  keyword: string;
  rankGroup: number;
  rankAbsolute: number;
  searchVolume: number;
  estimatedTraffic: number;
  cpc: number;
  keywordDifficulty: number;
  searchIntent: string;
  rankingUrl: string;
}

interface FixturePage {
  url: string;
  estimatedTraffic: number;
  keywordCount: number;
  topKeyword: string;
  topKeywordPosition: number;
  pageTitle: string;
}

const SEARCH_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
] as const;

/** Stable 32-bit hash. Not cryptographic — determinism is the only goal. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Deterministic value in [min, max]. */
function between(seed: string, min: number, max: number): number {
  return min + (hash(seed) % Math.max(1, max - min + 1));
}

/**
 * A domain with no data is a real and important case — the UI must render it as
 * "not available" rather than zero, and the visibility share must refuse to
 * compute. `example-nodata.com` reproduces it on demand.
 */
const NO_DATA_DOMAINS = new Set(["example-nodata.com", "nodata.test"]);

export function fixtureOverview(
  domain: string,
  snapshotDate: string,
): FixtureOverview {
  if (NO_DATA_DOMAINS.has(domain)) {
    return {
      organicTrafficEstimate: null,
      organicKeywordCount: null,
      backlinkCount: null,
      referringDomainCount: null,
      rankSignal: null,
    };
  }
  const seed = `${domain}|${snapshotDate}`;
  // Gentle day-over-day drift so deltas and trend charts have something real
  // to show, rather than a flat line that hides a broken delta computation.
  const drift = (between(`${seed}|drift`, 0, 200) - 100) / 1000;
  const baseTraffic = between(domain, 500, 250_000);
  return {
    organicTrafficEstimate: Math.round(baseTraffic * (1 + drift)),
    organicKeywordCount: between(`${domain}|kw`, 100, 40_000),
    backlinkCount: between(`${domain}|bl`, 200, 900_000),
    referringDomainCount: between(`${domain}|rd`, 50, 12_000),
    rankSignal: between(`${domain}|rank`, 1, 1000),
  };
}

export function fixtureKeywords(
  domain: string,
  snapshotDate: string,
  limit: number,
): FixtureKeyword[] {
  if (NO_DATA_DOMAINS.has(domain)) return [];
  const label = domain.split(".")[0] ?? domain;
  const stems = [
    "bitcoin",
    "custodia bitcoin",
    "comprare bitcoin",
    "wallet bitcoin",
    "exchange criptovalute",
    "criptovalute",
    "bitcoin italia",
    "investire in bitcoin",
    "quotazione bitcoin",
    "sicurezza bitcoin",
  ];
  const out: FixtureKeyword[] = [];
  for (let i = 0; i < limit; i += 1) {
    const stem = stems[i % stems.length] ?? "bitcoin";
    const keyword = i < stems.length ? stem : `${stem} ${label} ${i}`;
    const seed = `${domain}|${snapshotDate}|${keyword}`;
    const rankGroup = between(seed, 1, 60);
    out.push({
      keyword,
      rankGroup,
      // rank_absolute counts ads and SERP features, so it is >= rank_group.
      rankAbsolute: rankGroup + between(`${seed}|abs`, 0, 4),
      searchVolume: between(`${seed}|vol`, 10, 90_000),
      estimatedTraffic: between(`${seed}|etv`, 0, 5_000),
      cpc: between(`${seed}|cpc`, 0, 900) / 100,
      keywordDifficulty: between(`${seed}|kd`, 1, 100),
      searchIntent:
        SEARCH_INTENTS[between(`${seed}|intent`, 0, 3)] ?? "informational",
      rankingUrl: `https://${domain}/${keyword.replace(/\s+/g, "-")}`,
    });
  }
  return out.toSorted((a, b) => b.estimatedTraffic - a.estimatedTraffic);
}

export function fixturePages(
  domain: string,
  snapshotDate: string,
  limit: number,
): FixturePage[] {
  if (NO_DATA_DOMAINS.has(domain)) return [];
  const slugs = [
    "",
    "blog",
    "prezzi",
    "chi-siamo",
    "custodia",
    "sicurezza",
    "faq",
    "contatti",
    "guide/bitcoin",
    "guide/wallet",
  ];
  const out: FixturePage[] = [];
  for (let i = 0; i < limit; i += 1) {
    const slug = slugs[i % slugs.length] ?? `page-${String(i)}`;
    const path = i < slugs.length ? slug : `${slug}-${String(i)}`;
    const seed = `${domain}|${snapshotDate}|${path}`;
    out.push({
      url: `https://${domain}/${path}`,
      estimatedTraffic: between(seed, 0, 20_000),
      keywordCount: between(`${seed}|kw`, 1, 900),
      topKeyword: `bitcoin ${path || "home"}`,
      topKeywordPosition: between(`${seed}|pos`, 1, 40),
      pageTitle: `${path || "Home"} — ${domain}`,
    });
  }
  return out.toSorted((a, b) => b.estimatedTraffic - a.estimatedTraffic);
}
