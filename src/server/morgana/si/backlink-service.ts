import type { Phase0Config } from "../phase0-env";
import { resolveProviderStatus } from "./service";
import {
  backlinkPersistenceFailure,
  logBacklinkFailure,
} from "./backlink-errors";
import { commitReservation, releaseReservation } from "./budget-authority";
import {
  backlinkDedupeKey,
  normalizeAnchor,
  normalizeBacklinkDomain,
} from "./backlink-normalize";
import { assessSnapshot, diffSnapshots } from "./backlink-diff";
import {
  createLiveBacklinkProvider,
  effectiveSampleLimit,
  mergeLimits,
  normalizeRawBacklink,
  type BacklinkProvider,
  type CollectionLimits,
} from "./backlink-provider";
import { createFixtureBacklinkProvider } from "./backlink-provider-fixture";
import * as store from "./backlink-store";
import * as entityStore from "./store";
import { newId, nowIso } from "./ids";
import { backlinkBudgetAllows, recordBacklinkUsage } from "./backlink-cost";
import { deriveBacklinkModels } from "./backlink-derive";

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
 * Hold capacity for this collection, or refuse it.
 *
 * Runs BEFORE the provider call, never after: checking afterwards would mean
 * the money is already spent. A fixture run is free and is therefore never
 * gated — gating it would make the whole feature untestable while no credential
 * exists.
 *
 * Every identifying field is passed explicitly, and the entity most of all:
 * without it the idempotency key collapses to a single hour-bucket shared by
 * every entity, and the second domain collected inside that hour is refused as
 * a duplicate of the first — which reads as "already paid for" when nothing of
 * the kind happened.
 */
async function authorizeCollection(
  config: Phase0Config,
  input: {
    live: boolean;
    entityId: string;
    target: string;
    sampleLimit: number;
    operationId: string;
    now: Date;
  },
): Promise<{
  allowed: boolean;
  reason: string | null;
  reservationId?: string;
}> {
  if (!input.live) return { allowed: true, reason: null };
  return backlinkBudgetAllows(config, {
    reservedForOtherPhasesUsd: RESERVED_FOR_EARLIER_PHASES_USD,
    now: input.now,
    entityId: input.entityId,
    target: input.target,
    sampleLimit: input.sampleLimit,
    operationId: input.operationId,
  });
}

/**
 * Close the reservation, whichever way the call went.
 *
 * A provider that answered is charged, so the reservation commits for what it
 * ACTUALLY cost — including when that exceeds the estimate, which is how the
 * Backlinks overrun (79 236 µUSD against a 25 000 µUSD estimate) becomes
 * visible instead of being truncated to the amount that was authorised.
 *
 * A provider that failed without cost gives its capacity back. A cost nobody
 * reported KEEPS holding it, because the call may still have been charged and
 * releasing capacity for money that was spent is how a cap is exceeded quietly.
 */
async function closeReservation(
  reservationId: string | null,
  collected: {
    providerOk: boolean;
    actualCostMicros: number;
    costStatus?: "reported" | "zero" | "not_reported";
  },
  now: Date,
): Promise<void> {
  if (!reservationId) return;
  if (collected.providerOk || collected.actualCostMicros > 0) {
    await commitReservation(reservationId, {
      actualCostMicros:
        collected.costStatus === "not_reported"
          ? null
          : collected.actualCostMicros,
      costStatus: collected.costStatus ?? "reported",
      now,
    });
    return;
  }
  await releaseReservation(reservationId, "PROVIDER_FAILED_NO_COST", now);
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
  // NOT a spread: an `undefined` override assigns over the default rather than
  // skipping it, which is how every limit became `undefined` and the sample
  // limit became NaN. See `mergeLimits`.
  const limits: CollectionLimits = mergeLimits(options.limits);
  const entity = await entityStore.getEntity(entityId);
  if (!entity) {
    return emptyResult(entityId, "unknown", "entity not found");
  }

  const provider = providerFor(config, env);

  // ONE ID FOR THE WHOLE PASS. The reservation, the ledger row and the snapshot
  // each used to carry their own null in `operation_id`, so three records of
  // the same collection could only be joined by timestamp. Minted here, before
  // anything is authorised, so even a refusal is attributable.
  const operationId = newId("bop");
  const sampleLimit = effectiveSampleLimit(limits);

  const budget = await authorizeCollection(config, {
    live: provider.name === "live",
    entityId,
    target: entity.canonicalDomain,
    sampleLimit,
    operationId,
    now,
  });
  const reservationId = budget.reservationId ?? null;
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
    operationId,
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

  await closeReservation(reservationId, collected, now);

  if (!collected.providerOk) {
    // A live failure explains itself once, sanitized, at the boundary that knew
    // what happened. A fixture provider never fails, so there is nothing to log
    // for it — and the absence of a code is itself informative.
    if (collected.failure) {
      // Passed through, not rebuilt. It is already a `TypedFailure` — the
      // classifier is the only thing that produces one — and copying it field
      // by field only existed to hang an assertion off `origin`.
      logBacklinkFailure({ entityId, jobId: null }, collected.failure);
    }
    // Record the failed pass so the gap in history is visible, then stop. No
    // diff, no events: we learned nothing about what exists.
    await store.saveSnapshot({
      entityId,
      snapshotDate: today(now),
      source: collected.source ?? "fixture",
      snapshotStatus: "no_data",
      snapshotStatusReason: collected.snapshotStatusReason ?? null,
      sampleLimit: collected.sampleLimit ?? null,
      costStatus: collected.costStatus ?? null,
      providerReportedCostMicros: collected.providerReportedCostMicros ?? null,
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
      operationId,
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

  const derived = await deriveBacklinkModels({
    entityId,
    upserts,
    referringDomains: collected.referringDomains,
    roots,
    diff,
    quality,
    limits,
    day: today(now),
    at,
    now,
  });
  const { lostDomains, events: stored } = derived;

  await store.saveSnapshot({
    entityId,
    snapshotDate: today(now),
    source: collected.source ?? "fixture",
    snapshotStatus: collected.snapshotStatus ?? "complete",
    snapshotStatusReason: collected.snapshotStatusReason ?? null,
    sampleLimit: collected.sampleLimit ?? null,
    datasetCoverage: collected.datasetCoverage ?? null,
    reportedBacklinkTotal: collected.reportedBacklinkTotal,
    reportedReferringDomainTotal:
      collected.reportedReferringDomainTotal ?? null,
    datasetSignature: collected.datasetSignature ?? null,
    costStatus: collected.costStatus ?? null,
    providerReportedCostMicros: collected.providerReportedCostMicros ?? null,
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
    domainsProcessed: derived.domainsProcessed,
    provider: collected.provider,
    estimatedCostMicros: collected.estimatedCostMicros,
    actualCostMicros: collected.actualCostMicros,
    operationId,
  });
  await entityStore.markEntityRefreshed(entityId, "backlinks", now.toISOString());

  return {
    entityId,
    provider: collected.provider,
    comparisonStatus: quality.status,
    comparisonReason: quality.reason,
    backlinksProcessed: upserts.length,
    domainsProcessed: derived.domainsProcessed,
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
