import { routeRisk, type RiskResult } from "./backlink-risk";
import { buildBacklinkGap } from "./backlink-diff";
import * as store from "./backlink-store";
import * as findingsStore from "./backlink-findings-store";
import * as entityStore from "./store";
import type { BrandProtectionSignals } from "./brand-protection";

/**
 * Morgana Search Intelligence — phase 3 event construction and gap recompute.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Split from backlink-service to stay inside the 400-line module limit. Both
 * functions here turn *already collected* data into derived output, so neither
 * can spend anything — which is a useful property to be able to state about a
 * whole module.
 */

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Turn diffs and risk into events.
 *
 * The dedupe key carries the day and the subject domain, so a domain that adds
 * forty links produces one event, and produces it once — the UNIQUE constraint
 * is the cooldown rather than a timer we would have to get right.
 */
export function buildEvents(input: {
  entityId: string;
  day: string;
  added: readonly { key: string; domain: string }[];
  removed: readonly { key: string; domain: string }[];
  riskByDomain: ReadonlyMap<string, RiskResult>;
  brandSignalsByDomain: ReadonlyMap<string, BrandProtectionSignals>;
}): findingsStore.BacklinkEventInput[] {
  const events: findingsStore.BacklinkEventInput[] = [];
  const seenDomains = new Set<string>();

  for (const item of input.added) {
    if (seenDomains.has(item.domain)) continue;
    seenDomains.add(item.domain);
    const risk = input.riskByDomain.get(item.domain);
    const brandProtection = input.brandSignalsByDomain.get(item.domain);
    const channel = risk ? routeRisk(risk) : "intel";

    if (
      risk &&
      (risk.classification === "suspicious" ||
        risk.classification === "high_risk")
    ) {
      events.push({
        eventType: risk.reasons.some(
          (reason) =>
            reason.component === "lookalike_domain" ||
            reason.component === "brand_in_domain",
        )
          ? "possible_impersonation"
          : "suspicious_link",
        entityId: input.entityId,
        subjectDomain: item.domain,
        severity: risk.classification === "high_risk" ? "critical" : "warning",
        channel: channel === "none" ? "none" : channel,
        riskScore: risk.score,
        riskClassification: risk.classification,
        reasons: risk.reasons,
        brandProtectionSignals: brandProtection?.hasSignals
          ? brandProtection.counts
          : null,
        brandProtectionStatus: brandProtection?.status ?? "no_known_signal",
        dedupeKey: `finding|${input.entityId}|${item.domain}|${input.day}`,
      });
      continue;
    }

    events.push({
      eventType: "referring_domain_gained",
      entityId: input.entityId,
      subjectDomain: item.domain,
      severity: "info",
      channel: "intel",
      riskScore: risk?.score ?? null,
      riskClassification: risk?.classification ?? null,
      dedupeKey: `gained|${input.entityId}|${item.domain}|${input.day}`,
    });
  }

  const lostDomains = new Set<string>();
  for (const item of input.removed) {
    if (lostDomains.has(item.domain)) continue;
    lostDomains.add(item.domain);
    events.push({
      eventType: "backlink_lost",
      entityId: input.entityId,
      subjectDomain: item.domain,
      severity: "notice",
      channel: "intel",
      dedupeKey: `lost|${input.entityId}|${item.domain}|${input.day}`,
    });
  }

  return events;
}

/**
 * Recompute the cross-entity backlink gap.
 *
 * Reads only what is already stored, so it costs nothing and can be re-run
 * whenever a competitor refresh lands.
 */
export async function recomputeBacklinkGap(
  options: { now?: Date } = {},
): Promise<{ status: string; domains: number; opportunities: number }> {
  const now = options.now ?? new Date();
  const entities = await entityStore.listEntities();
  const primary = entities.filter((entity) => entity.entityType === "primary");
  const competitors = entities.filter(
    (entity) => entity.entityType !== "primary",
  );
  if (primary.length === 0) {
    return { status: "no_primary_entity", domains: 0, opportunities: 0 };
  }

  const primaryDomains: {
    normalizedDomain: string;
    domain: string;
    domainRank: number | null;
    spamScore: number | null;
  }[] = [];
  const riskByDomain = new Map<
    string,
    "low" | "review" | "suspicious" | "high_risk"
  >();
  for (const entity of primary) {
    for (const row of await store.listReferringDomains(entity.id, {
      status: "active",
      limit: 1000,
    })) {
      primaryDomains.push({
        normalizedDomain: row.normalizedDomain,
        domain: row.domain,
        domainRank: row.domainRank,
        spamScore: row.spamScore,
      });
      if (row.riskClassification)
        riskByDomain.set(row.normalizedDomain, row.riskClassification);
    }
  }

  const competitorDomains = [];
  for (const entity of competitors) {
    const rows = await store.listReferringDomains(entity.id, {
      status: "active",
      limit: 1000,
    });
    competitorDomains.push({
      entityId: entity.id,
      domains: rows.map((row) => ({
        normalizedDomain: row.normalizedDomain,
        domain: row.domain,
        domainRank: row.domainRank,
        spamScore: row.spamScore,
      })),
    });
  }

  const gap = buildBacklinkGap({
    primaryDomains,
    competitorDomains,
    riskByDomain,
  });
  await findingsStore.saveGapSnapshots(
    gap.map((row) => ({
      normalizedDomain: row.normalizedDomain,
      domain: row.domain,
      snapshotDate: today(now),
      category: row.category,
      competitorEntityIds: row.competitorEntityIds,
      linksPrimary: row.linksPrimary,
      competitorCount: row.competitorCount,
      domainRank: row.domainRank ?? null,
      spamScore: row.spamScore ?? null,
      riskClassification: row.riskClassification ?? null,
      opportunityScore: row.opportunityScore,
    })),
  );

  return {
    status: "ok",
    domains: gap.length,
    opportunities: gap.filter((row) => row.category === "new_opportunity")
      .length,
  };
}
