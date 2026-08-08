import { RANK_FREQUENCY_HOURS } from "./scheduler-policy";

/**
 * Morgana Search Intelligence — keyword normalisation and clustering.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P7).
 *
 * Pure. Cluster assignment is deterministic rule matching, deliberately not AI:
 * a keyword landing in the wrong cluster silently reweights Share of Search, and
 * a rule you can read is a rule you can correct.
 */

export type Priority = "critical" | "high" | "normal" | "low";

/**
 * Lowercase, collapse whitespace, strip surrounding punctuation. Accents are
 * PRESERVED — in Italian "perche" and "perché" are different queries, and
 * folding them would merge two keywords that rank differently.
 */
export function normalizeKeyword(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function isValidKeyword(input: string): boolean {
  const normalized = normalizeKeyword(input);
  return normalized.length >= 2 && normalized.length <= 200;
}

/** Scheduled check interval, derived from priority (§7 cadences). */
export function frequencyHoursFor(priority: Priority): number {
  return RANK_FREQUENCY_HOURS[priority];
}

/** Weight applied to a keyword's Share-of-Search contribution. */
export function priorityWeight(priority: Priority): number {
  switch (priority) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "normal":
      return 1;
    case "low":
      return 0.5;
  }
}

interface ClusterRule {
  slug: string;
  name: string;
  weight: number;
  /** Matched against the normalised keyword, in order; first match wins. */
  patterns: readonly string[];
}

/**
 * Default clusters. Data, not logic: an operator can add, rename or reweight
 * them, and nothing in the code branches on a specific slug.
 *
 * Order matters — brand terms are checked first so "custodia bitcoin checksig"
 * lands in the brand cluster rather than the generic custody one.
 */
export const DEFAULT_CLUSTERS: readonly ClusterRule[] = [
  {
    slug: "brand-checksig",
    name: "Brand CheckSig",
    weight: 3,
    patterns: ["checksig", "check sig", "check-sig"],
  },
  {
    slug: "competitor-brand",
    name: "Competitor Brand",
    weight: 1.5,
    patterns: ["conio", "binance", "coinbase", "bitpanda", "young platform"],
  },
  {
    slug: "custodia-bitcoin",
    name: "Custodia Bitcoin",
    weight: 2.5,
    patterns: ["custodia bitcoin", "bitcoin custody", "custodire bitcoin"],
  },
  {
    slug: "custodia-crypto",
    name: "Custodia Crypto",
    weight: 2,
    patterns: [
      "custodia crypto",
      "crypto custody",
      "custodia criptovalute",
      "custodia asset digitali",
    ],
  },
  {
    slug: "acquisto-bitcoin",
    name: "Acquisto Bitcoin",
    weight: 2,
    patterns: ["comprare bitcoin", "acquistare bitcoin", "acquisto bitcoin"],
  },
  {
    slug: "sicurezza",
    name: "Sicurezza",
    weight: 2,
    patterns: ["sicurezza", "sicuro", "truffa", "rischi"],
  },
  {
    slug: "mica-casp",
    name: "MiCA e CASP",
    weight: 2,
    patterns: ["mica", "casp", "regolamento", "normativa"],
  },
  {
    slug: "tassazione",
    name: "Tassazione",
    weight: 1.5,
    patterns: ["tassazione", "tasse", "fisco", "dichiarazione"],
  },
  {
    slug: "successione",
    name: "Successione",
    weight: 1.5,
    patterns: ["successione", "eredità", "eredita", "testamento"],
  },
  {
    slug: "proof-of-reserves",
    name: "Proof of Reserves",
    weight: 2,
    patterns: ["proof of reserves", "riserve", "prova delle riserve"],
  },
  {
    slug: "dgi",
    name: "Digital Gold Institute",
    weight: 2.5,
    patterns: ["digital gold institute", "ferdinando ametrano", "ametrano"],
  },
  {
    slug: "bitcoin-education",
    name: "Bitcoin Education",
    weight: 1,
    patterns: [
      "cos'è bitcoin",
      "cos e bitcoin",
      "come funziona bitcoin",
      "guida bitcoin",
    ],
  },
];

/**
 * Assign a cluster by first matching rule. Returns null when nothing matches —
 * an unclustered keyword is a visible gap in the configuration, not something
 * to bucket into a catch-all where it would silently pick up a weight.
 */
export function classifyKeyword(
  keyword: string,
  clusters: readonly ClusterRule[] = DEFAULT_CLUSTERS,
): ClusterRule | null {
  const normalized = normalizeKeyword(keyword);
  for (const cluster of clusters) {
    if (cluster.patterns.some((pattern) => normalized.includes(pattern))) {
      return cluster;
    }
  }
  return null;
}

/** Seed watchlist. Data only — nothing in the code depends on these strings. */
export const SEED_KEYWORDS: readonly { keyword: string; priority: Priority }[] =
  [
    { keyword: "checksig", priority: "critical" },
    { keyword: "check sig", priority: "critical" },
    { keyword: "digital gold institute", priority: "critical" },
    { keyword: "ferdinando ametrano", priority: "critical" },
    { keyword: "custodia bitcoin", priority: "critical" },
    { keyword: "custodia crypto", priority: "high" },
    { keyword: "bitcoin custody", priority: "high" },
    { keyword: "crypto custody", priority: "high" },
    { keyword: "comprare bitcoin", priority: "high" },
    { keyword: "comprare bitcoin in sicurezza", priority: "normal" },
    { keyword: "sicurezza bitcoin", priority: "normal" },
    { keyword: "mica italia", priority: "normal" },
    { keyword: "casp italia", priority: "normal" },
    { keyword: "proof of reserves", priority: "normal" },
    { keyword: "successione bitcoin", priority: "low" },
    { keyword: "tassazione bitcoin", priority: "low" },
  ];
