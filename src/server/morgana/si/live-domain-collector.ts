import { z } from "zod";
import { loadDataforseoSections } from "@/server/lib/dataforseo/client";
import { CollectorCallError } from "./collection-log";

/**
 * Morgana Search Intelligence — phase 1 live collector.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * The adapter between this bounded context and the upstream DataForSEO client.
 * It is deliberately thin: the transport, the retry policy and the credential
 * lookup already exist in `src/server/lib/dataforseo/`, and `runtime-env.ts`
 * already maps `DATAFORSEO_API_KEY` to `DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY`,
 * so the engine reaches its own account and can never reach Brand Monitoring's.
 *
 * WHY IT BYPASSES `createDataforseoClient`. That factory wraps every fetcher in
 * `meter()`, which charges an organization's usage credits through the upstream
 * billing subsystem. This engine has no organization, no customer and no credit
 * balance — it has a budget guard and a cost ledger of its own, which is what
 * `SEO_DATAFORSEO_*_COST_CAP_USD` is enforced against. So it loads the SECTION
 * FETCHERS directly (`loadDataforseoSections`), which is the un-metered layer
 * below that wrapper, and accounts for spend itself.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP.
 *
 * **Cost comes from the provider, never from a call count.** Every fetcher
 * returns `billing.costUsd` — what DataForSEO says it charged. That is what
 * lands in the ledger. Inferring cost from the number of requests would drift
 * the moment a plan or an endpoint price changes, and drift silently.
 *
 * **An error is never an empty dataset.** A failed call throws out of here. It
 * must not become `{ organicKeywordCount: 0 }`, because zero keywords is a
 * measurement and "we could not ask" is not. The caller records the failure and
 * leaves the snapshot absent.
 *
 * **A missing metric stays null.** DataForSEO omits fields for domains it has
 * no data on, and `??` to zero would turn "unknown" into "none".
 */

/** Metrics the phase-1 snapshot stores. Every field nullable, deliberately. */
interface LiveOverviewMetrics {
  organicTrafficEstimate: number | null;
  organicKeywordCount: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  rankSignal: number | null;
}

interface LiveKeyword {
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

interface LivePage {
  url: string;
  estimatedTraffic: number;
  keywordCount: number;
  topKeyword: string;
  topKeywordPosition: number;
  pageTitle: string;
}

interface LiveOverviewResult {
  metrics: LiveOverviewMetrics;
  keywords: LiveKeyword[];
  pages: LivePage[];
  /** Every provider call made, with the endpoint and what it cost. */
  calls: CallRecord[];
  /**
   * How much of the intended snapshot this actually is.
   *
   * `no_data`  — the provider answered and knows nothing about this domain.
   *              Not an error and not a zero: the metrics come back null.
   * `partial`  — the overview reported keywords but the detail sections came
   *              back empty. That combination is a provider gap or a mapping
   *              defect, never a complete snapshot, and saying so is the whole
   *              point: the first live run looked fine while returning nothing.
   * `complete` — overview and details agree.
   */
  completeness: "complete" | "partial" | "no_data";
  partialReason?: string | null;
}

/**
 * What one call cost, as the provider stated it — or the fact that it did not.
 *
 * `null` is not zero. DataForSEO normally reports `cost` on every task, but a
 * response that omits it used to produce `NaN` here, and NaN does not fail
 * where you would want it to: it passed through the collector, through
 * `persistSnapshot`, and only died at the ledger's `col + ?` binding, which D1
 * rejects. The observed result was a snapshot written with real metrics, a job
 * marked failed, and NO ledger row — losing the record of a call already paid
 * for.
 *
 * Coercing the absence to 0 would have hidden the same problem more quietly, so
 * it stays absent all the way to the ledger, which counts it separately.
 */
interface CallCost {
  micros: number | null;
  status: "reported" | "zero" | "not_reported";
}

function readCost(billing: { costUsd?: number } | undefined): CallCost {
  const usd = billing?.costUsd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    return { micros: null, status: "not_reported" };
  }
  const micros = Math.round(usd * 1_000_000);
  return { micros, status: micros === 0 ? "zero" : "reported" };
}

/** One provider call, with the endpoint it hit and what it cost. */
interface CallRecord {
  endpointPath: string;
  cost: CallCost;
}

/**
 * Run one section fetcher, tagging a throw with the endpoint it came from.
 *
 * The three calls below share one caller-side catch, so without this the
 * endpoint attributed to a failure was a constant — and the constant named the
 * overview, the call most likely to have already succeeded. The endpoint is
 * passed in rather than read from the response because a call that throws has
 * no response to read it from.
 */
async function callSection<T>(
  endpointPath: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new CollectorCallError(endpointPath, { cause });
  }
}

/**
 * The endpoints, as the collector names them when a call never got far enough
 * to report its own billing path.
 */
const ENDPOINT = {
  overview: "dataforseo_labs/google/domain_rank_overview/live",
  rankedKeywords: "dataforseo_labs/google/ranked_keywords/live",
  relevantPages: "dataforseo_labs/google/relevant_pages/live",
} as const;

/**
 * Is this host in scope for the entity?
 *
 * The apex and its `www` host are the same site — checksig.com redirects to
 * www.checksig.com, and its rankings are attributed there. Any OTHER subdomain
 * is a different property and is excluded unless the entity opted in.
 *
 * This exists because the provider has no "apex plus www" option: Labs takes a
 * single `include_subdomains` boolean. Asking for subdomains and filtering here
 * is the narrowest way to get www without also collecting blog., app., or
 * anything else that happens to hang off the domain.
 */
export function hostInEntityScope(
  host: string,
  registrableDomain: string,
  includeSubdomains: boolean,
): boolean {
  const target = host.trim().toLowerCase().replace(/\.$/, "");
  const root = registrableDomain.trim().toLowerCase();
  if (!target || !root) return false;
  if (target === root || target === `www.${root}`) return true;
  return includeSubdomains && target.endsWith(`.${root}`);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The Labs domain-rank overview item, read defensively.
 *
 * The SDK types this loosely and DataForSEO adds fields over time, so this
 * validates only what is read and tolerates the rest. `.passthrough()` rather
 * than `.strict()` on purpose: an unexpected provider field must not fail a
 * charged call.
 */
const domainMetricsSchema = z
  .object({
    organic_etv: z.number().nullable().optional(),
    metrics: z
      .object({
        organic: z
          .object({
            etv: z.number().nullable().optional(),
            count: z.number().nullable().optional(),
            pos_1: z.number().nullable().optional(),
            pos_2_3: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The ranked-keyword rows the phase-1 model keeps, and the ones it drops. */
function mapRankedKeywords(
  items: readonly RankedKeywordLike[],
  registrableDomain: string,
  includeSubdomains: boolean,
): LiveKeyword[] {
  const keywords: LiveKeyword[] = [];
  for (const item of items) {
    const keyword = item.keyword_data?.keyword ?? item.keyword;
    const serpItem = item.ranked_serp_element?.serp_item;
    const rankAbsolute =
      serpItem?.rank_absolute ?? item.ranked_serp_element?.rank_absolute;
    const url = serpItem?.url ?? item.ranked_serp_element?.url;
    // A keyword with no position or no ranking URL is not a ranking. Dropping
    // it beats storing a placeholder that later reads as a real position.
    if (!keyword || typeof rankAbsolute !== "number" || !url) continue;
    // The provider was asked for subdomains so www would be included; this is
    // where everything that is not the site itself is dropped again.
    const host = hostOf(url);
    if (!host || !hostInEntityScope(host, registrableDomain, includeSubdomains))
      continue;
    const info = item.keyword_data?.keyword_info;
    keywords.push({
      keyword,
      rankGroup: rankAbsolute,
      rankAbsolute,
      searchVolume: info?.search_volume ?? 0,
      estimatedTraffic: Math.round(
        serpItem?.etv ?? item.ranked_serp_element?.etv ?? 0,
      ),
      cpc: info?.cpc ?? 0,
      keywordDifficulty:
        item.keyword_data?.keyword_properties?.keyword_difficulty ??
        info?.keyword_difficulty ??
        0,
      searchIntent: "unknown",
      rankingUrl: url,
    });
  }
  return keywords;
}

/** Relevant pages, validated defensively and mapped onto the phase-1 model. */
function mapRelevantPages(
  items: readonly unknown[],
  registrableDomain: string,
  includeSubdomains: boolean,
): LivePage[] {
  const pages: LivePage[] = [];
  for (const item of items) {
    const parsed = relevantPageSchema.safeParse(item);
    if (!parsed.success) continue;
    const url = parsed.data.page_address;
    if (!url) continue;
    // `page_address` is sometimes a bare host+path rather than an absolute URL.
    const host = hostOf(url) ?? hostOf(`https://${url}`);
    if (!host || !hostInEntityScope(host, registrableDomain, includeSubdomains))
      continue;
    const organic = parsed.data.metrics?.organic;
    pages.push({
      url,
      estimatedTraffic: Math.round(organic?.etv ?? 0),
      keywordCount: organic?.count ?? 0,
      // Relevant-pages does not carry a top keyword; the phase-1 model wants
      // the field, so it is reported as absent rather than invented.
      topKeyword: "",
      topKeywordPosition: 0,
      pageTitle: "",
    });
  }
  return pages;
}

/** The shape of a ranked-keyword row this collector reads. */
interface RankedKeywordLike {
  keyword?: string | null;
  keyword_data?: {
    keyword?: string | null;
    keyword_info?: {
      search_volume?: number | null;
      cpc?: number | null;
      keyword_difficulty?: number | null;
    } | null;
    keyword_properties?: { keyword_difficulty?: number | null } | null;
  } | null;
  ranked_serp_element?: {
    serp_item?: {
      url?: string | null;
      rank_absolute?: number | null;
      etv?: number | null;
    } | null;
    url?: string | null;
    rank_absolute?: number | null;
    etv?: number | null;
  } | null;
}

/**
 * Collect a domain overview for one entity.
 *
 * Three Labs calls, all `live` (no task lifecycle at this tier): the rank
 * overview for the aggregate metrics, ranked keywords for the top-keyword list,
 * and relevant pages for the top-page list. Their costs are summed as reported.
 */
export async function collectDomainOverview(input: {
  domain: string;
  locationCode: number;
  languageCode: string;
  keywordLimit: number;
  pageLimit: number;
  includeSubdomains?: boolean;
}): Promise<LiveOverviewResult> {
  const sections = await loadDataforseoSections();
  const calls: CallRecord[] = [];

  const overview = await callSection(ENDPOINT.overview, () =>
    sections.fetchDomainRankOverview({
      target: input.domain,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
    }),
  );
  calls.push({
    endpointPath: overview.billing.path.join("/"),
    cost: readCost(overview.billing),
  });

  const rawMetrics = overview.data[0];
  const parsedMetrics = rawMetrics
    ? domainMetricsSchema.safeParse(rawMetrics)
    : null;
  const organic = parsedMetrics?.success
    ? parsedMetrics.data.metrics?.organic
    : undefined;

  const organicTrafficEstimate = numberOrNull(
    organic?.etv ??
      (parsedMetrics?.success ? parsedMetrics.data.organic_etv : null),
  );
  const organicKeywordCount = numberOrNull(organic?.count);

  // The provider answered and knows nothing about this domain. Asking for its
  // keywords and pages would be two more charged calls for two more empty
  // lists, so stop here — and report null metrics, not zeroes.
  if (organicTrafficEstimate === null && organicKeywordCount === null) {
    return {
      metrics: {
        organicTrafficEstimate: null,
        organicKeywordCount: null,
        backlinkCount: null,
        referringDomainCount: null,
        rankSignal: null,
      },
      keywords: [],
      pages: [],
      calls,
      completeness: "no_data",
    };
  }

  // SCOPE. `fetchDomainRankOverview` has no subdomain switch and counts the
  // apex together with its www host; the detail endpoints take an explicit
  // `include_subdomains`. Passing `false` there asked a NARROWER question than
  // the overview, and for a site that redirects apex -> www — checksig.com does —
  // the answer was an empty list beside a keyword count of 21.
  //
  // So the detail calls ask for subdomains, matching the overview's scope, and
  // the rows are filtered back to the apex and its www host here. The provider
  // has no 'apex plus www' option, and this is the narrowest way to get one.
  const ranked = await callSection(ENDPOINT.rankedKeywords, () =>
    sections.fetchRankedKeywords({
      target: input.domain,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      limit: input.keywordLimit,
      itemTypes: ["organic"],
      orderBy: ["ranked_serp_element.serp_item.etv,desc"],
      includeSubdomains: true,
    }),
  );
  calls.push({
    endpointPath: ranked.billing.path.join("/"),
    cost: readCost(ranked.billing),
  });
  const keywords = mapRankedKeywords(
    ranked.data.items,
    input.domain,
    input.includeSubdomains ?? false,
  );

  const relevant = await callSection(ENDPOINT.relevantPages, () =>
    sections.fetchRelevantPages({
      target: input.domain,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      limit: input.pageLimit,
      orderBy: ["metrics.organic.etv,desc"],
    }),
  );
  calls.push({
    endpointPath: relevant.billing.path.join("/"),
    cost: readCost(relevant.billing),
  });
  const pages = mapRelevantPages(
    relevant.data.items,
    input.domain,
    input.includeSubdomains ?? false,
  );

  // An overview reporting keywords while both detail sections come back empty
  // is not a complete snapshot. It is either a provider gap or a mapping
  // defect, and calling it complete is how the first live run looked fine.
  const detailsMissing =
    (organicKeywordCount ?? 0) > 0 &&
    keywords.length === 0 &&
    pages.length === 0;

  return {
    metrics: {
      organicTrafficEstimate:
        organicTrafficEstimate === null
          ? null
          : Math.round(organicTrafficEstimate),
      organicKeywordCount,
      // Phase 1's aggregate backlink figures come from the phase-3 backlink
      // collector's own snapshot, not from Labs. Null here means 'not collected
      // by this call', which the read model already distinguishes from zero.
      backlinkCount: null,
      referringDomainCount: null,
      rankSignal: numberOrNull(organic?.pos_1),
    },
    keywords,
    pages,
    calls,
    completeness: detailsMissing ? "partial" : "complete",
    partialReason: detailsMissing
      ? `overview reported ${String(organicKeywordCount)} organic keywords but ranked_keywords and relevant_pages returned no in-scope rows`
      : null,
  };
}

const relevantPageSchema = z
  .object({
    page_address: z.string().nullable().optional(),
    metrics: z
      .object({
        organic: z
          .object({
            etv: z.number().nullable().optional(),
            count: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
