import { classifyAnchor, aggregateAnchors } from "./backlink-anchors";
import { normalizeBacklinkDomain } from "./backlink-normalize";
import { scoreBacklinkRisk, type RiskResult } from "./backlink-risk";
import { buildEvents } from "./backlink-findings";
import {
  getBrandProtectionSignals,
  type BrandProtectionSignals,
} from "./brand-protection";
import * as store from "./backlink-store";
import * as anchorStore from "./backlink-anchor-store";
import * as findingsStore from "./backlink-findings-store";
import type { CollectionLimits } from "./backlink-provider";

/**
 * Morgana Search Intelligence — turning collected links into derived models.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Split from `backlink-service.ts`, which had grown past the repository's module
 * size limit and whose `refreshBacklinks` had grown past its complexity limit.
 * This is the seam the stages were already separated by in comments: collection
 * and persistence of the links themselves stay there, and everything DERIVED
 * from them — per-domain risk, anchor distribution, the events those two imply —
 * lives here.
 *
 * Nothing in this file talks to a provider or spends anything. It reads what was
 * already collected and writes what follows from it, which is why it can be
 * reasoned about without knowing whether the collection was live or a fixture.
 */

/** Brand tokens the whole phase reasons about. Lowercase, canonical first. */
const BRAND_TOKENS = ["checksig"] as const;

interface DeriveInput {
  entityId: string;
  /** The links just persisted, already normalized. */
  upserts: readonly {
    anchorText: string | null;
    normalizedAnchor: string | null;
    normalizedSourceDomain: string;
  }[];
  referringDomains: readonly {
    domain: string;
    backlinkCount: number | null;
    targetPageCount: number | null;
    domainRank: number | null;
    spamScore: number | null;
    firstSeen: string | null;
    country: string | null;
  }[];
  /** Apex domains this organisation owns; a link from one is never a threat. */
  roots: readonly string[];
  diff: {
    added: { key: string; domain: string }[];
    removed: { key: string; domain: string }[];
  };
  /** Only a complete snapshot may mark a domain lost. */
  quality: { status: "complete" | "partial" | "not_comparable" };
  limits: CollectionLimits;
  day: string;
  at: string;
  now: Date;
}

interface DeriveResult {
  domainsProcessed: number;
  lostDomains: number;
  events: Awaited<ReturnType<typeof findingsStore.saveBacklinkEvents>>;
}

/**
 * Score every referring domain, aggregate the anchors, and emit the events.
 *
 * Ordered, and the order is load-bearing: anchors are classified before the
 * domains are scored because the risk score reads them, and the events are
 * built last because routing depends on the score.
 */
export async function deriveBacklinkModels(
  input: DeriveInput,
): Promise<DeriveResult> {
  const { entityId, upserts, roots, diff, quality, limits, at, now } = input;
  const collected = { referringDomains: input.referringDomains };
  // --- referring domains, risk and findings -------------------------------
  const anchorsByDomain = new Map<string, string[]>();
  const signalsByDomain = new Map<string, string[]>();
  for (const upsert of upserts) {
    const classification = classifyAnchor({
      anchor: upsert.anchorText,
      brandTokens: BRAND_TOKENS,
      sourceRoot: normalizeBacklinkDomain(upsert.normalizedSourceDomain).root,
      officialRoots: roots,
    });
    if (classification.normalized) {
      const list = anchorsByDomain.get(upsert.normalizedSourceDomain) ?? [];
      list.push(classification.normalized);
      anchorsByDomain.set(upsert.normalizedSourceDomain, list);
    }
    if (classification.signals.length > 0) {
      const list = signalsByDomain.get(upsert.normalizedSourceDomain) ?? [];
      list.push(...classification.signals);
      signalsByDomain.set(upsert.normalizedSourceDomain, list);
    }
  }

  const riskByDomain = new Map<string, RiskResult>();
  const brandSignalsByDomain = new Map<string, BrandProtectionSignals>();
  const domainRows: store.UpsertReferringDomainInput[] = [];

  for (const raw of collected.referringDomains) {
    const normalized = normalizeBacklinkDomain(raw.domain);
    const brandProtection = await getBrandProtectionSignals(
      normalized.normalized,
    );
    brandSignalsByDomain.set(normalized.normalized, brandProtection);
    const risk = scoreBacklinkRisk({
      normalizedDomain: normalized.normalized,
      domainRoot: normalized.root,
      tld: normalized.tld,
      brandTokens: BRAND_TOKENS,
      officialRoots: roots,
      anchors: anchorsByDomain.get(normalized.normalized) ?? [],
      anchorSignals: signalsByDomain.get(normalized.normalized) ?? [],
      domainRank: raw.domainRank,
      spamScore: raw.spamScore,
      firstSeenAt: raw.firstSeen,
      targetsOwnedDomain: true,
      brandProtection: brandProtection.hasSignals
        ? brandProtection.counts
        : null,
      now,
    });
    riskByDomain.set(normalized.normalized, risk);
    domainRows.push({
      entityId,
      domain: raw.domain,
      normalizedDomain: normalized.normalized,
      backlinkCount: raw.backlinkCount,
      targetPageCount: raw.targetPageCount,
      domainRank: raw.domainRank,
      spamScore: raw.spamScore,
      country: raw.country,
      tld: normalized.tld,
      firstSeenAt: raw.firstSeen ?? at,
      riskScore: risk.score,
      riskClassification: risk.classification,
      riskReasons: JSON.stringify(risk.reasons),
    });
  }
  await store.upsertReferringDomains(domainRows);

  // Referring domains follow the same rule as individual links: a domain is
  // only marked lost from a snapshot complete enough to prove its absence.
  let lostDomains = 0;
  if (quality.status === "complete") {
    const seen = new Set(domainRows.map((row) => row.normalizedDomain));
    const previouslyActive = await store.listReferringDomains(entityId, {
      status: "active",
      limit: 1000,
    });
    const gone = previouslyActive
      .filter((row) => !seen.has(row.normalizedDomain))
      .map((row) => row.normalizedDomain);
    lostDomains = await store.markReferringDomainsLost(entityId, gone);
  }

  // --- anchors ------------------------------------------------------------
  const aggregates = aggregateAnchors(upserts, (anchor, sourceRoot) =>
    classifyAnchor({
      anchor,
      brandTokens: BRAND_TOKENS,
      sourceRoot,
      officialRoots: roots,
    }),
  ).slice(0, limits.anchors);
  await anchorStore.saveAnchorSnapshots(
    aggregates.map((aggregate) => ({
      entityId,
      snapshotDate: input.day,
      anchorText: aggregate.anchorText,
      normalizedAnchor: aggregate.normalizedAnchor,
      category: aggregate.category,
      backlinkCount: aggregate.backlinkCount,
      referringDomainCount: aggregate.referringDomainCount,
      suspiciousSignal: aggregate.suspiciousSignal,
      firstSeenAt: at,
    })),
  );

  // --- events -------------------------------------------------------------
  const events = buildEvents({
    entityId,
    day: input.day,
    added: diff.added,
    removed: diff.removed,
    riskByDomain,
    brandSignalsByDomain,
  });
  const stored = await findingsStore.saveBacklinkEvents(events);

  return {
    domainsProcessed: domainRows.length,
    lostDomains,
    events: stored,
  };
}
