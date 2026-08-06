import { routeRisk, type RiskResult } from "./backlink-risk";
import type { BacklinkEventInput } from "./backlink-findings-store";
import type { BrandProtectionSignals } from "./brand-protection";

/**
 * Morgana Search Intelligence — phase 3 event construction.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Pure, and separated from backlink-events so it stays that way: importing a
 * store here would pull `cloudflare:workers` into the eager module graph and
 * make this logic untestable outside a Worker isolate. Only the row TYPE is
 * imported, which erases at compile time.
 */

/** One suspicious-link or impersonation finding for a scored domain. */
function findingFor(input: {
  entityId: string;
  day: string;
  domain: string;
  risk: RiskResult;
  brandProtection: BrandProtectionSignals | undefined;
}): BacklinkEventInput {
  const channel = routeRisk(input.risk);
  return {
    // A hostname that carries our brand is an impersonation question; anything
    // else scoring this high is a link-quality question. Different work.
    eventType: input.risk.reasons.some(
      (reason) =>
        reason.component === "lookalike_domain" ||
        reason.component === "brand_in_domain",
    )
      ? "possible_impersonation"
      : "suspicious_link",
    entityId: input.entityId,
    subjectDomain: input.domain,
    severity:
      input.risk.classification === "high_risk" ? "critical" : "warning",
    channel: channel === "none" ? "none" : channel,
    riskScore: input.risk.score,
    riskClassification: input.risk.classification,
    reasons: input.risk.reasons,
    brandProtectionSignals: input.brandProtection?.hasSignals
      ? input.brandProtection.counts
      : null,
    brandProtectionStatus: input.brandProtection?.status ?? "no_known_signal",
    dedupeKey: `finding|${input.entityId}|${input.domain}|${input.day}`,
  };
}

/**
 * Turn diffs and risk into events.
 *
 * The dedupe key carries the day and the subject domain, so a domain that adds
 * forty links produces one event, and produces it once — the UNIQUE constraint
 * is the cooldown rather than a timer we would have to get right.
 *
 * Findings are raised for EVERY domain that scores suspicious or above, not
 * only for newly added ones. Deriving them from the diff alone meant a domain
 * present in the very first snapshot — which has no diff, because there is
 * nothing to compare it against — could never produce a finding at all. Any
 * domain already impersonating us when monitoring started would have been
 * invisible forever, which is precisely the case that matters most.
 */
export function buildEvents(input: {
  entityId: string;
  day: string;
  added: readonly { key: string; domain: string }[];
  removed: readonly { key: string; domain: string }[];
  riskByDomain: ReadonlyMap<string, RiskResult>;
  brandSignalsByDomain: ReadonlyMap<string, BrandProtectionSignals>;
}): BacklinkEventInput[] {
  const events: BacklinkEventInput[] = [];
  const flagged = new Set<string>();

  for (const [domain, risk] of input.riskByDomain) {
    if (
      risk.classification !== "suspicious" &&
      risk.classification !== "high_risk"
    ) {
      continue;
    }
    flagged.add(domain);
    events.push(
      findingFor({
        entityId: input.entityId,
        day: input.day,
        domain,
        risk,
        brandProtection: input.brandSignalsByDomain.get(domain),
      }),
    );
  }

  const seenDomains = new Set<string>();
  for (const item of input.added) {
    // A domain that already produced a finding does not also produce a routine
    // "gained" event: one domain, one story per day.
    if (seenDomains.has(item.domain) || flagged.has(item.domain)) continue;
    seenDomains.add(item.domain);
    const risk = input.riskByDomain.get(item.domain);
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
