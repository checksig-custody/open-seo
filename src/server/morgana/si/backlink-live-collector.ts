import { z } from "zod";
import { loadDataforseoSections } from "@/server/lib/dataforseo/client";
import {
  accountFor,
  readProviderCost,
  type CollectionAccounting,
} from "./collection-accounting";
import { classifyBacklinkError, type TypedFailure } from "./backlink-errors";
import {
  normalizeBacklinkDomain,
  normalizeBacklinkUrl,
} from "./backlink-normalize";

/**
 * Morgana Search Intelligence — the live backlink collector.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P13).
 *
 * Replaces the refusal that stood here: `createLiveBacklinkProvider` returned
 * empty data with `providerOk: false`, which was the right shape while no
 * credential existed and the wrong thing to ship once one did.
 *
 * THREE CALLS, AND WHY. Summary answers "how big is the profile" for the whole
 * index; referring domains and backlinks answer "which ones", and only ever
 * about a SAMPLE. Keeping them separate is what lets a snapshot report a
 * 10,000-backlink profile of which it examined 100 rows — a distinction the
 * fixture provider never had to make, because a fixture is always complete.
 *
 * THE SAMPLE IS NOT THE PROFILE. Every row list carries the limit that produced
 * it and the total the provider reports, so nothing downstream can read an
 * absence from a truncated list as a loss. That single rule is why this file
 * returns `reportedTotals` alongside the rows rather than counts derived from
 * them.
 *
 * Null is not zero, as everywhere else in this engine: a metric the provider
 * does not state stays null, and only a stated zero is a zero.
 */

export const BACKLINKS_SUMMARY_ENDPOINT = "v3/backlinks/summary/live";
export const BACKLINKS_ROWS_ENDPOINT = "v3/backlinks/backlinks/live";
export const BACKLINKS_DOMAINS_ENDPOINT = "v3/backlinks/referring_domains/live";

/**
 * The most one collection could plausibly cost, in micro-USD.
 *
 * Backlinks is priced per request plus per returned row, so the ceiling is a
 * function of the limits this collector asks for — which are deliberately small
 * (see `DEFAULT_SAMPLE_LIMIT`). The figure is several times DataForSEO's list
 * price for three such requests, because the pre-flight must assume the worst
 * case and the provider states its charge only in the response.
 *
 * NOT copied from the SERP worst case: a rank submission and a backlink profile
 * are priced on different models, and reusing that number would have been a
 * guess wearing a constant's clothes.
 */
export const WORST_CASE_BACKLINK_MICROS = 25_000;

/** Rows sampled per list call. Small on purpose: cost scales with rows. */
export const DEFAULT_SAMPLE_LIMIT = 100;

interface LiveBacklinkRow {
  sourceUrl: string;
  sourceDomain: string;
  sourceMainDomain: string | null;
  targetUrl: string;
  targetDomain: string | null;
  anchorText: string | null;
  backlinkType: string | null;
  isDofollow: boolean | null;
  isBroken: boolean | null;
  firstSeen: string | null;
  lastSeen: string | null;
  lostDate: string | null;
  domainRank: number | null;
  pageRank: number | null;
  spamScore: number | null;
  language: string | null;
  providerBacklinkId: string | null;
}

interface LiveReferringDomain {
  domain: string;
  mainDomain: string | null;
  backlinkCount: number | null;
  dofollowCount: number | null;
  nofollowCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  lostDate: string | null;
  domainRank: number | null;
  spamScore: number | null;
  country: string | null;
  language: string | null;
}

interface LiveProfile {
  backlinkCount: number | null;
  referringDomainCount: number | null;
  referringMainDomainCount: number | null;
  referringPageCount: number | null;
  dofollowCount: number | null;
  nofollowCount: number | null;
  brokenBacklinks: number | null;
  referringIps: number | null;
  referringSubnets: number | null;
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
  rank: number | null;
  spamScore: number | null;
}

type LiveCollectionOutcome =
  | {
      status: "completed";
      profile: LiveProfile;
      backlinks: LiveBacklinkRow[];
      referringDomains: LiveReferringDomain[];
      /** What the provider says exists, against what was sampled. */
      reportedTotals: {
        backlinks: number | null;
        referringDomains: number | null;
      };
      sampleLimit: number;
      snapshotStatus: "complete" | "partial" | "no_data";
      snapshotStatusReason: string | null;
      accounting: CollectionAccounting;
      endpoints: string[];
    }
  | {
      status: "failed";
      failure: TypedFailure;
      accounting: CollectionAccounting;
    };

/** A finite number, or nothing. A NaN must never reach a metric or a cost. */
const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const intOrNull = (value: unknown): number | null => {
  const n = numOrNull(value);
  return n === null ? null : Math.round(n);
};

const strOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * The summary payload, re-validated here.
 *
 * The upstream client already parses it; this schema exists because the fields
 * this collector depends on are a small, explicit subset, and because
 * `.catch(null)` states the null-is-not-zero rule once for all of them.
 */
const summarySchema = z
  .object({
    target: z.string().nullable().catch(null),
    rank: z.number().nullable().catch(null),
    backlinks: z.number().nullable().catch(null),
    referring_domains: z.number().nullable().catch(null),
    referring_main_domains: z.number().nullable().catch(null),
    referring_pages: z.number().nullable().catch(null),
    referring_ips: z.number().nullable().catch(null),
    referring_subnets: z.number().nullable().catch(null),
    broken_backlinks: z.number().nullable().catch(null),
    new_backlinks: z.number().nullable().catch(null),
    lost_backlinks: z.number().nullable().catch(null),
    new_referring_domains: z.number().nullable().catch(null),
    lost_referring_domains: z.number().nullable().catch(null),
    backlinks_spam_score: z.number().nullable().catch(null),
    referring_links_attributes: z
      .record(z.string(), z.unknown())
      .nullable()
      .catch(null),
  })
  .partial()
  .catch({});

/** Dofollow / nofollow, when the provider breaks the profile down that way. */
function followSplit(attributes: Record<string, unknown> | null | undefined): {
  dofollow: number | null;
  nofollow: number | null;
} {
  if (!attributes) return { dofollow: null, nofollow: null };
  const nofollow = intOrNull(attributes.nofollow);
  const total = Object.values(attributes).reduce<number | null>(
    (sum, value) => {
      const n = intOrNull(value);
      if (n === null) return sum;
      return (sum ?? 0) + n;
    },
    null,
  );
  if (total === null) return { dofollow: null, nofollow: nofollow };
  // Dofollow is the remainder only when the nofollow figure is stated; deriving
  // it from an absent value would be inventing the split.
  return {
    dofollow: nofollow === null ? null : Math.max(0, total - nofollow),
    nofollow,
  };
}

function toProfile(raw: unknown): LiveProfile {
  const parsed = summarySchema.safeParse(raw);
  const s = parsed.success ? parsed.data : {};
  const split = followSplit(s.referring_links_attributes ?? null);
  return {
    backlinkCount: intOrNull(s.backlinks),
    referringDomainCount: intOrNull(s.referring_domains),
    referringMainDomainCount: intOrNull(s.referring_main_domains),
    referringPageCount: intOrNull(s.referring_pages),
    dofollowCount: split.dofollow,
    nofollowCount: split.nofollow,
    brokenBacklinks: intOrNull(s.broken_backlinks),
    referringIps: intOrNull(s.referring_ips),
    referringSubnets: intOrNull(s.referring_subnets),
    newBacklinks: intOrNull(s.new_backlinks),
    lostBacklinks: intOrNull(s.lost_backlinks),
    newReferringDomains: intOrNull(s.new_referring_domains),
    lostReferringDomains: intOrNull(s.lost_referring_domains),
    rank: intOrNull(s.rank),
    spamScore: intOrNull(s.backlinks_spam_score),
  };
}

const rowSchema = z
  .object({
    domain_from: z.string().nullable().catch(null),
    url_from: z.string().nullable().catch(null),
    url_to: z.string().nullable().catch(null),
    domain_to: z.string().nullable().catch(null),
    anchor: z.string().nullable().catch(null),
    item_type: z.string().nullable().catch(null),
    dofollow: z.boolean().nullable().catch(null),
    is_broken: z.boolean().nullable().catch(null),
    domain_from_rank: z.number().nullable().catch(null),
    page_from_rank: z.number().nullable().catch(null),
    backlink_spam_score: z.number().nullable().catch(null),
    first_seen: z.string().nullable().catch(null),
    last_seen: z.string().nullable().catch(null),
    last_visited: z.string().nullable().catch(null),
    lost_date: z.string().nullable().catch(null),
    language: z.string().nullable().catch(null),
    url_from_https: z.boolean().nullable().catch(null),
  })
  .partial()
  .catch({});

function toBacklink(raw: unknown): LiveBacklinkRow | null {
  const parsed = rowSchema.safeParse(raw);
  const r = parsed.success ? parsed.data : {};
  const sourceUrl = strOrNull(r.url_from);
  const sourceDomain = strOrNull(r.domain_from);
  // No source, nothing to store: a backlink without an origin is not a
  // backlink, and inventing one from the target would be worse than dropping it.
  if (!sourceUrl && !sourceDomain) return null;

  const domain = normalizeBacklinkDomain(sourceDomain ?? sourceUrl ?? "");
  const targetUrl = strOrNull(r.url_to);
  return {
    sourceUrl: sourceUrl ?? `https://${domain.normalized}/`,
    sourceDomain: domain.normalized,
    sourceMainDomain: domain.root || null,
    targetUrl: targetUrl ?? "",
    targetDomain:
      strOrNull(r.domain_to) ??
      (targetUrl ? normalizeBacklinkDomain(targetUrl).normalized : null),
    // An empty anchor stays empty. It is a real and common shape — an image
    // link — and giving it an invented string would fabricate a signal.
    anchorText: typeof r.anchor === "string" ? r.anchor : null,
    backlinkType: strOrNull(r.item_type),
    isDofollow: typeof r.dofollow === "boolean" ? r.dofollow : null,
    isBroken: typeof r.is_broken === "boolean" ? r.is_broken : null,
    firstSeen: strOrNull(r.first_seen),
    lastSeen: strOrNull(r.last_seen) ?? strOrNull(r.last_visited),
    lostDate: strOrNull(r.lost_date),
    domainRank: intOrNull(r.domain_from_rank),
    pageRank: intOrNull(r.page_from_rank),
    spamScore: intOrNull(r.backlink_spam_score),
    language: strOrNull(r.language),
    // The provider gives no stable row id, so the identity is the pair of
    // canonicalized URLs — which is also what the store deduplicates on.
    providerBacklinkId: null,
  };
}

const domainRowSchema = z
  .object({
    domain: z.string().nullable().catch(null),
    backlinks: z.number().nullable().catch(null),
    dofollow: z.number().nullable().catch(null),
    nofollow: z.number().nullable().catch(null),
    first_seen: z.string().nullable().catch(null),
    last_seen: z.string().nullable().catch(null),
    lost_date: z.string().nullable().catch(null),
    rank: z.number().nullable().catch(null),
    backlinks_spam_score: z.number().nullable().catch(null),
    country: z.string().nullable().catch(null),
    referring_links_attributes: z
      .record(z.string(), z.unknown())
      .nullable()
      .catch(null),
  })
  .partial()
  .catch({});

function toReferringDomain(raw: unknown): LiveReferringDomain | null {
  const parsed = domainRowSchema.safeParse(raw);
  const r = parsed.success ? parsed.data : {};
  const domain = strOrNull(r.domain);
  if (!domain) return null;
  const normalized = normalizeBacklinkDomain(domain);
  return {
    domain: normalized.normalized,
    mainDomain: normalized.root || null,
    backlinkCount: intOrNull(r.backlinks),
    dofollowCount: intOrNull(r.dofollow),
    nofollowCount: intOrNull(r.nofollow),
    firstSeen: strOrNull(r.first_seen),
    lastSeen: strOrNull(r.last_seen),
    lostDate: strOrNull(r.lost_date),
    domainRank: intOrNull(r.rank),
    spamScore: intOrNull(r.backlinks_spam_score),
    country: strOrNull(r.country),
    language: null,
  };
}

/**
 * Collect one domain's backlink profile and a bounded sample of its rows.
 *
 * Throws nothing. A provider failure comes back typed, with the requests still
 * accounted — they happened, and may have been charged — because an error must
 * never be mistaken for an empty profile. An empty profile from a healthy
 * response is `no_data`, which is a different and legitimate answer.
 */
export async function collectLiveBacklinks(input: {
  target: string;
  sampleLimit?: number;
}): Promise<LiveCollectionOutcome> {
  const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const calls: {
    endpointPath: string;
    cost: ReturnType<typeof readProviderCost>;
  }[] = [];
  let endpoint = BACKLINKS_SUMMARY_ENDPOINT;

  try {
    const sections = await loadDataforseoSections();

    const summary = await sections.fetchBacklinksSummary({
      // `include_subdomains`, `exclude_internal_backlinks` and
      // `backlinks_status_type: live` are fixed by the upstream payload builder,
      // so every call here asks the same question of the index — which is what
      // makes two snapshots comparable at all.
      target: input.target,
    });
    endpoint = summary.billing.path.join("/");
    calls.push({
      endpointPath: endpoint,
      cost: readProviderCost(summary.billing),
    });
    const profile = toProfile(summary.data);

    endpoint = BACKLINKS_DOMAINS_ENDPOINT;
    const domains = await sections.fetchReferringDomains({
      target: input.target,
      limit: sampleLimit,
      orderBy: ["backlinks,desc"],
    });
    calls.push({
      endpointPath: domains.billing.path.join("/"),
      cost: readProviderCost(domains.billing),
    });

    endpoint = BACKLINKS_ROWS_ENDPOINT;
    const rows = await sections.fetchBacklinksRows({
      target: input.target,
      limit: sampleLimit,
      mode: "as_is",
      orderBy: ["rank,desc"],
    });
    calls.push({
      endpointPath: rows.billing.path.join("/"),
      cost: readProviderCost(rows.billing),
    });

    const backlinks = rows.data.items
      .map((item) => toBacklink(item))
      .filter((row): row is LiveBacklinkRow => row !== null);
    const referringDomains = domains.data.items
      .map((item) => toReferringDomain(item))
      .filter((row): row is LiveReferringDomain => row !== null);

    const reportedTotals = {
      backlinks: profile.backlinkCount ?? intOrNull(rows.data.totalCount),
      referringDomains:
        profile.referringDomainCount ?? intOrNull(domains.data.totalCount),
    };

    // THE THREE ANSWERS A HEALTHY RESPONSE CAN GIVE.
    //
    // `no_data` — the provider knows this domain and holds nothing for it, or
    //             holds nothing worth returning. A real answer.
    // `partial` — it returned as many rows as we asked for, so the sample is a
    //             ceiling and the profile is larger than what was examined.
    // `complete` — the sample covers the whole profile.
    const noData =
      backlinks.length === 0 &&
      referringDomains.length === 0 &&
      (profile.backlinkCount === null || profile.backlinkCount === 0);
    const truncated =
      backlinks.length >= sampleLimit || referringDomains.length >= sampleLimit;

    return {
      status: "completed",
      profile,
      backlinks,
      referringDomains,
      reportedTotals,
      sampleLimit,
      snapshotStatus: noData ? "no_data" : truncated ? "partial" : "complete",
      snapshotStatusReason: noData
        ? "provider returned no backlink rows for this target"
        : truncated
          ? `sample limited to ${String(sampleLimit)} rows per list`
          : null,
      accounting: accountFor(calls, { metered: true, paidSubmission: true }),
      endpoints: calls.map((call) => call.endpointPath),
    };
  } catch (error) {
    // Whatever succeeded before the throw is already in `calls` with its cost;
    // the failing call is added with its cost NOT reported, because it may have
    // been charged and the response cannot say.
    calls.push({
      endpointPath: endpoint,
      cost: { micros: null, status: "not_reported" },
    });
    return {
      status: "failed",
      failure: classifyBacklinkError(error, endpoint),
      accounting: accountFor(calls, { metered: true, paidSubmission: true }),
    };
  }
}

/** Exported for the tests: the row shapes are the contract of this module. */
export const __test = { toProfile, toBacklink, toReferringDomain, followSplit };

export { normalizeBacklinkUrl };
