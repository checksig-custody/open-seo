import type { Phase0Config } from "../phase0-env";
import { resolveProviderStatus } from "./service";
import {
  backlinkPersistenceFailure,
  logBacklinkFailure,
} from "./backlink-errors";
import {
  backlinkDedupeKey,
  normalizeAnchor,
  normalizeBacklinkDomain,
} from "./backlink-normalize";
import { aggregateAnchors, classifyAnchor } from "./backlink-anchors";
import { scoreBacklinkRisk, type RiskResult } from "./backlink-risk";
import { assessSnapshot, diffSnapshots } from "./backlink-diff";
import {
  createFixtureBacklinkProvider,
  createLiveBacklinkProvider,
  DEFAULT_LIMITS,
  normalizeRawBacklink,
  type BacklinkProvider,
  type CollectionLimits,
} from "./backlink-provider";
import * as store from "./backlink-store";
import * as anchorStore from "./backlink-anchor-store";
import * as findingsStore from "./backlink-findings-store";
import * as entityStore from "./store";
import {
  getBrandProtectionSignals,
  type BrandProtectionSignals,
} from "./brand-protection";
import { nowIso } from "./ids";
import { buildEvents } from "./backlink-findings";
import { backlinkBudgetAllows, recordBacklinkUsage } from "./backlink-cost";

/**
 * Morgana Search Intelligence — phase 3 collection and analysis.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * One refresh does: collect → persist → diff against the previous snapshot →
 * score risk → classify anchors → emit events. The order is not negotiable; in
 * particular the diff has to run against what we just stored, and the risk
 * score has to exist before events are routed, because routing depends on it.
 */

/**
 * Budget already committed to keyword tracking and the CheckSig domain
 * overview. Backlinks get what is left, so this is subtracted from the monthly
 * cap before the guard decides — per the phase-3 priority order.
 */
const RESERVED_FOR_EARLIER_PHASES_USD = 6;

/** Brand tokens the whole phase reasons about. Lowercase, canonical first. */
const BRAND_TOKENS = ["checksig"] as const;

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function providerFor(config: Phase0Config, env: object): BacklinkProvider {
  // Reuses the phase-1 resolver rather than re-deriving "do we have a
  // credential", so all three phases agree on what "live" means. Paid calls off
  // or credential absent means fixtures; the live provider refuses rather than
  // returning empty data, so a misconfiguration can never look like "every
  // backlink disappeared".
  return resolveProviderStatus(config, env) === "live"
    ? createLiveBacklinkProvider()
    : createFixtureBacklinkProvider();
}

interface RefreshResult {
  entityId: string;
  provider: string;
  comparisonStatus: "complete" | "partial" | "not_comparable";
  comparisonReason: string | null;
  backlinksProcessed: number;
  domainsProcessed: number;
  newBacklinks: number;
  lostBacklinks: number;
  eventsDetected: number;
  findingsDetected: number;
  skipped?: string;
}

/** Roots we own. A link from one of these can never be an impersonation. */
async function officialRoots(): Promise<string[]> {
  const entities = await entityStore.listEntities();
  return entities
    .filter((entity) => entity.entityType === "primary")
    .map((entity) => normalizeBacklinkDomain(entity.canonicalDomain).root);
}

/**
 * Refresh one entity's backlink profile.
 *
 * Bounded by `limits` so a single invocation cannot exhaust the subrequest
 * budget or the daily cap, and so the snapshot's completeness is a knowable
 * fact rather than a guess.
 */
export async function refreshBacklinks(
  config: Phase0Config,
  env: object,
  entityId: string,
  options: {
    limits?: Partial<CollectionLimits>;
    now?: Date;
    budgetExhausted?: boolean;
  } = {},
): Promise<RefreshResult> {
  const now = options.now ?? new Date();
  const limits: CollectionLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const entity = await entityStore.getEntity(entityId);
  if (!entity) {
    return emptyResult(entityId, "unknown", "entity not found");
  }

  const provider = providerFor(config, env);
  // The budget guard runs BEFORE the provider call, not after: checking
  // afterwards would mean the money is already spent. A fixture run is free, so
  // it is never gated — gating it would make the whole feature untestable while
  // no credential exists.
  const budget =
    provider.name === "live"
      ? await backlinkBudgetAllows(config, {
          reservedForOtherPhasesUsd: RESERVED_FOR_EARLIER_PHASES_USD,
          now,
        })
      : { allowed: true, reason: null };
  if (!budget.allowed) {
    return emptyResult(
      entityId,
      provider.name,
      budget.reason ?? "budget exhausted",
    );
  }

  const previousSnapshot = await store.latestSnapshot(entityId);
  const previousActive = await store.activeBacklinks(entityId, 5000);

  const collected = await provider.collect({
    target: entity.canonicalDomain,
    limits,
    budgetExhausted: options.budgetExhausted,
  });

  // Recorded for every outcome, including failure: a failed paid call still
  // costs, and a ledger that only counts successes understates spend.
  await recordBacklinkUsage({
    entityId,
    endpointPath: "backlinks/collect",
    meteringClass: provider.name === "live" ? "paid_submission" : "cache",
    backlinksProcessed: collected.backlinks.length,
    domainsProcessed: collected.referringDomains.length,
    estimatedCostMicros: collected.estimatedCostMicros,
    actualCostMicros: collected.actualCostMicros,
  });

  const quality = assessSnapshot({
    providerOk: collected.providerOk,
    collected: collected.backlinks.length,
    reportedTotal: collected.reportedBacklinkTotal,
    limit: limits.backlinks,
    budgetTruncated:
      options.budgetExhausted === true || collected.truncatedReason !== null,
    noBaseline: previousSnapshot === undefined,
  });

  if (!collected.providerOk) {
    // A live failure explains itself once, sanitized, at the boundary that knew
    // what happened. A fixture provider never fails, so there is nothing to log
    // for it — and the absence of a code is itself informative.
    if (collected.failure) {
      logBacklinkFailure(
        { entityId, jobId: null },
        {
          origin: collected.failure.origin as "provider",
          code: collected.failure.code,
          errorClass: collected.failure.errorClass,
          message: collected.failure.message,
          endpoint: collected.failure.endpoint,
        },
      );
    }
    // Record the failed pass so the gap in history is visible, then stop. No
    // diff, no events: we learned nothing about what exists.
    await store.saveSnapshot({
      entityId,
      snapshotDate: today(now),
      backlinkCount: null,
      referringDomainCount: null,
      dofollowCount: null,
      nofollowCount: null,
      newBacklinks: null,
      lostBacklinks: null,
      newReferringDomains: null,
      lostReferringDomains: null,
      comparisonStatus: "not_comparable",
      comparisonReason: collected.truncatedReason ?? quality.reason,
      backlinksProcessed: 0,
      domainsProcessed: 0,
      provider: collected.provider,
      estimatedCostMicros: 0,
      actualCostMicros: 0,
    });
    return emptyResult(
      entityId,
      collected.provider,
      collected.truncatedReason ?? "provider unavailable",
    );
  }

  const roots = await officialRoots();
  const at = nowIso();

  // --- persist backlinks --------------------------------------------------
  const upserts = collected.backlinks.map((raw) => {
    const normalized = normalizeRawBacklink(raw);
    const normalizedAnchor = normalizeAnchor(raw.anchorText);
    return {
      targetEntityId: entityId,
      sourceUrl: raw.sourceUrl,
      normalizedSourceUrl: normalized.normalizedSourceUrl,
      sourceDomain: raw.sourceDomain,
      normalizedSourceDomain: normalized.normalizedSourceDomain,
      targetUrl: raw.targetUrl,
      normalizedTargetUrl: normalized.normalizedTargetUrl,
      anchorText: raw.anchorText,
      normalizedAnchor,
      linkType: raw.linkType,
      isDofollow: raw.isDofollow,
      domainRank: raw.domainRank,
      pageRank: raw.pageRank,
      spamScore: raw.spamScore,
      providerBacklinkId: raw.providerBacklinkId,
      provider: collected.provider,
      firstSeenAt: raw.firstSeen ?? at,
      dedupeKey: backlinkDedupeKey({
        targetEntityId: entityId,
        normalizedSourceUrl: normalized.normalizedSourceUrl,
        normalizedTargetUrl: normalized.normalizedTargetUrl,
        normalizedAnchor,
        linkType: raw.linkType,
      }),
    };
  });
  try {
    await store.upsertBacklinks(upserts);
  } catch (error) {
    // THE PROVIDER SUCCEEDED; WE FAILED. The call is already in the ledger a
    // few lines above, which is the order that keeps the money recorded when
    // the data is lost. Blaming the provider here would send the next reader to
    // the wrong logs, so the origin is `persistence` and the cost stays.
    logBacklinkFailure(
      { entityId, jobId: null },
      backlinkPersistenceFailure(error, "backlinks/persist"),
    );
    throw error;
  }

  // --- diff ---------------------------------------------------------------
  const diff = diffSnapshots(
    previousActive.map((row) => ({
      key: row.dedupeKey,
      domain: row.normalizedSourceDomain,
    })),
    upserts.map((row) => ({
      key: row.dedupeKey,
      domain: row.normalizedSourceDomain,
    })),
    quality,
  );
  // Losses are already gated by `diffSnapshots`; the second gate is the
  // `unknown` status a previously-lost link keeps until it is seen again.
  await store.markBacklinksLost(diff.removed.map((item) => item.key));

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
      snapshotDate: today(now),
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
    day: today(now),
    added: diff.added,
    removed: diff.removed,
    riskByDomain,
    brandSignalsByDomain,
  });
  const stored = await findingsStore.saveBacklinkEvents(events);

  await store.saveSnapshot({
    entityId,
    snapshotDate: today(now),
    backlinkCount: collected.profile.backlinkCount,
    referringDomainCount: collected.profile.referringDomainCount,
    dofollowCount: collected.profile.dofollowCount,
    nofollowCount: collected.profile.nofollowCount,
    // Null, not zero, when the snapshot could not be differenced: "we do not
    // know how many were added" and "none were added" are different facts.
    newBacklinks:
      quality.status === "not_comparable" ? null : diff.added.length,
    lostBacklinks: quality.status === "complete" ? diff.removed.length : null,
    newReferringDomains: null,
    lostReferringDomains: quality.status === "complete" ? lostDomains : null,
    comparisonStatus: quality.status,
    comparisonReason: quality.reason,
    backlinksProcessed: upserts.length,
    domainsProcessed: domainRows.length,
    provider: collected.provider,
    estimatedCostMicros: collected.estimatedCostMicros,
    actualCostMicros: collected.actualCostMicros,
  });

  return {
    entityId,
    provider: collected.provider,
    comparisonStatus: quality.status,
    comparisonReason: quality.reason,
    backlinksProcessed: upserts.length,
    domainsProcessed: domainRows.length,
    newBacklinks: diff.added.length,
    lostBacklinks: diff.removed.length,
    eventsDetected: stored.length,
    findingsDetected: stored.filter(
      (event) =>
        event.eventType === "suspicious_link" ||
        event.eventType === "possible_impersonation",
    ).length,
  };
}

function emptyResult(
  entityId: string,
  provider: string,
  skipped: string,
): RefreshResult {
  return {
    entityId,
    provider,
    comparisonStatus: "not_comparable",
    comparisonReason: skipped,
    backlinksProcessed: 0,
    domainsProcessed: 0,
    newBacklinks: 0,
    lostBacklinks: 0,
    eventsDetected: 0,
    findingsDetected: 0,
    skipped,
  };
}
