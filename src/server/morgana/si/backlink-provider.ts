import {
  normalizeBacklinkDomain,
  normalizeBacklinkUrl,
} from "./backlink-normalize";
import {
  collectLiveBacklinks,
  DEFAULT_SAMPLE_LIMIT,
} from "./backlink-live-collector";

/**
 * Morgana Search Intelligence — phase 3 provider boundary.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Two implementations behind one interface: the deterministic fixture provider
 * used everywhere today, and a DataForSEO adapter that is written but can only
 * run once `DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY` exists. The engine must
 * never reach for Brand Monitoring's credential, so the live path refuses
 * explicitly rather than falling back to anything.
 *
 * No page is ever fetched here. Everything comes from the provider's own index.
 */

interface RawBacklink {
  sourceUrl: string;
  sourceDomain: string;
  targetUrl: string;
  anchorText: string | null;
  linkType: string;
  isDofollow: boolean | null;
  firstSeen: string | null;
  lastSeen: string | null;
  isLost: boolean | null;
  domainRank: number | null;
  pageRank: number | null;
  spamScore: number | null;
  providerBacklinkId: string | null;
}

interface RawReferringDomain {
  domain: string;
  backlinkCount: number | null;
  targetPageCount: number | null;
  domainRank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  country: string | null;
}

interface BacklinkProfile {
  backlinkCount: number | null;
  referringDomainCount: number | null;
  dofollowCount: number | null;
  nofollowCount: number | null;
  /** Provider-reported deltas, when it supplies them. Null when it does not. */
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
  spamScore: number | null;
}

export interface CollectionResult {
  profile: BacklinkProfile;
  backlinks: RawBacklink[];
  referringDomains: RawReferringDomain[];
  provider: string;
  /** True when the provider answered at all. Drives comparison status. */
  providerOk: boolean;
  /** Total the provider claims exists, when known. */
  reportedBacklinkTotal: number | null;
  estimatedCostMicros: number;
  actualCostMicros: number;
  /** Set when collection stopped early for a reason other than "no more data". */
  truncatedReason: string | null;
  /**
   * What a REAL collection knows and a fixture never had to.
   *
   * A fixture answers completely and free; a provider answers about a sample of
   * a much larger index, sometimes partially, and charges. These fields carry
   * that difference to the store, so a truncated sample can never be read as a
   * whole profile — which is the one way this feature could lie.
   */
  source?: "dataforseo" | "fixture";
  snapshotStatus?: "complete" | "partial" | "no_data";
  snapshotStatusReason?: string | null;
  sampleLimit?: number | null;
  reportedReferringDomainTotal?: number | null;
  /** Sampled / reported. Null when the provider states no total to divide by. */
  datasetCoverage?: number | null;
  /** The request shape, so only like-for-like snapshots are ever compared. */
  datasetSignature?: string | null;
  costStatus?: "reported" | "zero" | "not_reported";
  providerReportedCostMicros?: number | null;
  /** Typed, sanitized, and absent when the collection succeeded. */
  failure?: {
    origin: string;
    code: string;
    errorClass: string;
    message: string;
    endpoint: string | null;
  } | null;
}

export interface CollectionLimits {
  backlinks: number;
  referringDomains: number;
  anchors: number;
}

/** Conservative defaults; every caller may override them from config. */
export const DEFAULT_LIMITS: CollectionLimits = {
  backlinks: 500,
  referringDomains: 250,
  anchors: 100,
};

/**
 * Apply a caller's partial overrides without letting an absent one win.
 *
 * `{...DEFAULT_LIMITS, ...{backlinks: undefined}}` yields `backlinks:
 * undefined` — a spread does not skip explicit `undefined`, it assigns it. The
 * HTTP route builds exactly that object (`num(body.backlink_limit) ??
 * undefined`), so a request that specified no limits ERASED all three defaults,
 * and `Math.min(undefined, …)` became `NaN`. That NaN reached the provider as
 * the row limit, the snapshot as its `sample_limit`, and the dataset signature
 * as the literal text `live|NaN|…` — which silently makes two snapshots
 * incomparable, since comparability is decided by signature equality.
 *
 * Only a finite, positive number may override a default. Anything else means
 * "not specified".
 */
function usableCount(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function mergeLimits(
  overrides: Partial<CollectionLimits> | undefined,
): CollectionLimits {
  return {
    backlinks: usableCount(overrides?.backlinks, DEFAULT_LIMITS.backlinks),
    referringDomains: usableCount(
      overrides?.referringDomains,
      DEFAULT_LIMITS.referringDomains,
    ),
    anchors: usableCount(overrides?.anchors, DEFAULT_LIMITS.anchors),
  };
}

/**
 * How many rows this collection will actually ask for.
 *
 * The smaller of what the caller wanted and what this collector will pay for.
 * Named and exported rather than inlined because two things need the same
 * answer: the live provider, which sends it, and the budget reservation, which
 * records the sample the estimate assumed. Cost scales with returned rows, so
 * a reservation stating a different sample from the one that was bought would
 * be worse than one stating none.
 *
 * It cannot return a non-finite number. A sample limit is used to build the
 * dataset signature, and a poisoned signature is worse than a missing one:
 * nothing downstream would notice, and two profiles that asked the same
 * question would be reported as having asked different ones.
 */
export function effectiveSampleLimit(limits: CollectionLimits): number {
  const resolved = Math.min(
    limits.backlinks,
    limits.referringDomains,
    DEFAULT_SAMPLE_LIMIT,
  );
  return Number.isFinite(resolved) && resolved > 0
    ? resolved
    : DEFAULT_SAMPLE_LIMIT;
}

export interface BacklinkProvider {
  readonly name: string;
  collect(input: {
    target: string;
    limits: CollectionLimits;
    budgetExhausted?: boolean;
  }): Promise<CollectionResult>;
}

// --- fixtures ---------------------------------------------------------------

/**
 * Deterministic pseudo-random source.
 *
 * Seeded by the target, so the same domain always produces the same profile:
 * a fixture that shuffled between runs would make new/lost detection look
 * broken and would make the UI impossible to review.
 */
function seededRandom(seed: string): () => number {
  let hash = 2_166_136_261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return () => {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    return Math.abs(hash % 100_000) / 100_000;
  };
}

const FIXTURE_SOURCE_DOMAINS = [
  "coindesk.com",
  "bitcoinmagazine.com",
  "ilsole24ore.com",
  "milanofinanza.it",
  "cointelegraph.com",
  "criptovaluta.it",
  "wired.it",
  "startupitalia.eu",
  "corriere.it",
  "repubblica.it",
  "blockchain4innovation.it",
  "bitcoin.org",
  "medium.com",
  "reddit.com",
  "linkedin.com",
  "youtube.com",
];

/**
 * A handful of fixture domains that deliberately look like impersonation
 * attempts, so the risk model, the routing rules and the review workflow can
 * all be exercised end to end without any real suspicious data.
 */
const FIXTURE_SUSPICIOUS = [
  {
    domain: "checksig-support.tk",
    anchor: "checksig login",
    rank: 3,
    spam: 78,
  },
  {
    domain: "chekcsig.com",
    anchor: "checksig wallet recovery",
    rank: 1,
    spam: 91,
  },
  {
    domain: "checksig-bonus.xyz",
    anchor: "checksig airdrop claim",
    rank: 5,
    spam: 66,
  },
];

const FIXTURE_ANCHORS = [
  "checksig",
  "custodia bitcoin",
  "clicca qui",
  "https://checksig.com",
  "checksig custodia istituzionale",
  "leggi di più",
  "bitcoin custody italia",
  null,
];

export function createFixtureBacklinkProvider(
  options: { includeSuspicious?: boolean } = {},
): BacklinkProvider {
  return {
    name: "fixture",
    collect({ target, limits }) {
      const random = seededRandom(target);
      const normalized = normalizeBacklinkDomain(target);
      const isPrimary = normalized.root.includes("checksig");
      const domainCount = 8 + Math.floor(random() * 8);
      const backlinks: RawBacklink[] = [];
      const referringDomains: RawReferringDomain[] = [];

      for (
        let i = 0;
        i < Math.min(domainCount, limits.referringDomains);
        i += 1
      ) {
        const domain =
          FIXTURE_SOURCE_DOMAINS[i % FIXTURE_SOURCE_DOMAINS.length] ??
          "example.com";
        const rank = 20 + Math.floor(random() * 70);
        const perDomain = 1 + Math.floor(random() * 3);
        referringDomains.push({
          domain,
          backlinkCount: perDomain,
          targetPageCount: 1 + Math.floor(random() * 2),
          domainRank: rank,
          spamScore: Math.floor(random() * 20),
          firstSeen: "2026-01-15T00:00:00.000Z",
          country: "IT",
        });
        for (
          let j = 0;
          j < perDomain && backlinks.length < limits.backlinks;
          j += 1
        ) {
          const anchor =
            FIXTURE_ANCHORS[(i + j) % FIXTURE_ANCHORS.length] ?? null;
          backlinks.push({
            sourceUrl: `https://${domain}/articolo-${String(i)}-${String(j)}`,
            sourceDomain: domain,
            targetUrl: `https://${normalized.normalized}/`,
            anchorText: anchor,
            linkType: "anchor",
            isDofollow: random() > 0.3,
            firstSeen: "2026-02-01T00:00:00.000Z",
            lastSeen: "2026-08-01T00:00:00.000Z",
            isLost: false,
            domainRank: rank,
            pageRank: Math.floor(rank * 0.7),
            spamScore: Math.floor(random() * 20),
            providerBacklinkId: null,
          });
        }
      }

      // Suspicious rows only for the primary entity: a competitor being
      // impersonated is not our finding to make.
      if (isPrimary && (options.includeSuspicious ?? true)) {
        for (const suspicious of FIXTURE_SUSPICIOUS) {
          referringDomains.push({
            domain: suspicious.domain,
            backlinkCount: 1,
            targetPageCount: 1,
            domainRank: suspicious.rank,
            spamScore: suspicious.spam,
            firstSeen: new Date(Date.now() - 5 * 86_400_000).toISOString(),
            country: null,
          });
          backlinks.push({
            sourceUrl: `https://${suspicious.domain}/`,
            sourceDomain: suspicious.domain,
            targetUrl: `https://${normalized.normalized}/`,
            anchorText: suspicious.anchor,
            linkType: "anchor",
            isDofollow: true,
            firstSeen: new Date(Date.now() - 5 * 86_400_000).toISOString(),
            lastSeen: new Date().toISOString(),
            isLost: false,
            domainRank: suspicious.rank,
            pageRank: 1,
            spamScore: suspicious.spam,
            providerBacklinkId: null,
          });
        }
      }

      const dofollow = backlinks.filter(
        (backlink) => backlink.isDofollow === true,
      ).length;
      return Promise.resolve({
        profile: {
          backlinkCount: backlinks.length,
          referringDomainCount: referringDomains.length,
          dofollowCount: dofollow,
          nofollowCount: backlinks.length - dofollow,
          // The fixture provider reports no deltas: those must be derived from
          // our own snapshots, which is the code path that actually matters.
          newBacklinks: null,
          lostBacklinks: null,
          newReferringDomains: null,
          lostReferringDomains: null,
          spamScore: null,
        },
        backlinks,
        referringDomains,
        provider: "fixture",
        providerOk: true,
        reportedBacklinkTotal: backlinks.length,
        estimatedCostMicros: 0,
        actualCostMicros: 0,
        truncatedReason: null,
      });
    },
  };
}

// --- live -------------------------------------------------------------------

/**
 * The DataForSEO-backed provider.
 *
 * Was a deliberate refusal while no credential existed — empty data with
 * `providerOk: false`, so an empty result could never flow into new/lost
 * detection and look like every backlink had vanished. The credential exists
 * now, so it collects.
 *
 * The refusal survives in a stronger form: anything other than a completed
 * provider response still returns `providerOk: false` with a typed failure, and
 * the caller keeps the snapshot `not_comparable` rather than storing an absence
 * as a fact.
 */
export function createLiveBacklinkProvider(): BacklinkProvider {
  return {
    name: "live",
    async collect(input) {
      // The sample is the smaller of what the caller asked for and what this
      // collector will pay for: cost scales with returned rows, and a first
      // live run should be inspectable rather than exhaustive.
      const sampleLimit = effectiveSampleLimit(input.limits);
      const outcome = await collectLiveBacklinks({
        target: input.target,
        sampleLimit,
      });

      if (outcome.status === "failed") {
        return {
          profile: EMPTY_PROFILE,
          backlinks: [],
          referringDomains: [],
          provider: "dataforseo",
          // The whole point: a failure is not an empty profile.
          providerOk: false,
          reportedBacklinkTotal: null,
          estimatedCostMicros: outcome.accounting.estimatedCostMicros,
          actualCostMicros: outcome.accounting.actualCostMicros,
          truncatedReason: outcome.failure.message,
          source: "dataforseo",
          snapshotStatus: "no_data",
          snapshotStatusReason: outcome.failure.message,
          sampleLimit,
          reportedReferringDomainTotal: null,
          datasetCoverage: null,
          datasetSignature: null,
          costStatus: outcome.accounting.costStatus,
          providerReportedCostMicros: outcome.accounting.actualCostMicros,
          failure: outcome.failure,
        };
      }

      const sampled = outcome.backlinks.length;
      const reported = outcome.reportedTotals.backlinks;
      return {
        profile: {
          backlinkCount: outcome.profile.backlinkCount,
          referringDomainCount: outcome.profile.referringDomainCount,
          dofollowCount: outcome.profile.dofollowCount,
          nofollowCount: outcome.profile.nofollowCount,
          newBacklinks: outcome.profile.newBacklinks,
          lostBacklinks: outcome.profile.lostBacklinks,
          newReferringDomains: outcome.profile.newReferringDomains,
          lostReferringDomains: outcome.profile.lostReferringDomains,
          spamScore: outcome.profile.spamScore,
        },
        backlinks: outcome.backlinks.map((row) => ({
          sourceUrl: row.sourceUrl,
          sourceDomain: row.sourceDomain,
          targetUrl: row.targetUrl,
          anchorText: row.anchorText,
          linkType: row.backlinkType ?? "unknown",
          isDofollow: row.isDofollow,
          firstSeen: row.firstSeen,
          lastSeen: row.lastSeen,
          isLost: row.lostDate === null ? null : true,
          domainRank: row.domainRank,
          pageRank: row.pageRank,
          spamScore: row.spamScore,
          providerBacklinkId: row.providerBacklinkId,
        })),
        referringDomains: outcome.referringDomains.map((row) => ({
          domain: row.domain,
          backlinkCount: row.backlinkCount,
          targetPageCount: null,
          domainRank: row.domainRank,
          spamScore: row.spamScore,
          firstSeen: row.firstSeen,
          country: row.country,
        })),
        provider: "dataforseo",
        providerOk: true,
        reportedBacklinkTotal: reported,
        estimatedCostMicros: outcome.accounting.estimatedCostMicros,
        actualCostMicros: outcome.accounting.actualCostMicros,
        truncatedReason: outcome.snapshotStatusReason,
        source: "dataforseo",
        snapshotStatus: outcome.snapshotStatus,
        snapshotStatusReason: outcome.snapshotStatusReason,
        sampleLimit: outcome.sampleLimit,
        reportedReferringDomainTotal: outcome.reportedTotals.referringDomains,
        // Coverage is only computable against a total the provider stated. A
        // ratio invented from the sample itself would always read 1.0 and mean
        // nothing.
        datasetCoverage:
          reported === null || reported === 0
            ? null
            : Math.min(1, sampled / reported),
        // COMPARABILITY IS DECIDED BY THIS STRING, so it may never be built
        // from a value that is not a number. A signature reading `live|NaN|…`
        // compares unequal to every other signature including its own kind,
        // and nothing downstream can tell that from a genuine change of
        // question. Null says "this run cannot be compared"; a poisoned string
        // says nothing and is believed.
        datasetSignature: Number.isFinite(outcome.sampleLimit)
          ? `live|${String(outcome.sampleLimit)}|subdomains=on|status=live|internal=excluded`
          : null,
        costStatus: outcome.accounting.costStatus,
        providerReportedCostMicros: outcome.accounting.actualCostMicros,
        failure: null,
      };
    },
  };
}

/** Nothing known about anything — the shape a refusal returns. */
const EMPTY_PROFILE: BacklinkProfile = {
  backlinkCount: null,
  referringDomainCount: null,
  dofollowCount: null,
  nofollowCount: null,
  newBacklinks: null,
  lostBacklinks: null,
  newReferringDomains: null,
  lostReferringDomains: null,
  spamScore: null,
};

/** Map a raw provider row onto the normalized shape the store persists. */
export function normalizeRawBacklink(raw: RawBacklink): {
  normalizedSourceUrl: string;
  normalizedSourceDomain: string;
  normalizedTargetUrl: string;
  sourceRoot: string;
  tld: string | null;
} {
  const domain = normalizeBacklinkDomain(raw.sourceDomain || raw.sourceUrl);
  return {
    normalizedSourceUrl: normalizeBacklinkUrl(raw.sourceUrl),
    normalizedSourceDomain: domain.normalized,
    normalizedTargetUrl: normalizeBacklinkUrl(raw.targetUrl),
    sourceRoot: domain.root,
    tld: domain.tld,
  };
}
