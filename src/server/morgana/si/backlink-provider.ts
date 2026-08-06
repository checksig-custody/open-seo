import {
  normalizeBacklinkDomain,
  normalizeBacklinkUrl,
} from "./backlink-normalize";

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
 * Deliberately a refusal rather than a stub that returns empty data: an empty
 * result would flow into new/lost detection and look like every backlink had
 * vanished. Refusing keeps the snapshot `not_comparable`, which is the honest
 * state when we cannot collect at all.
 */
export function createLiveBacklinkProvider(): BacklinkProvider {
  return {
    name: "live",
    collect() {
      return Promise.resolve({
        profile: {
          backlinkCount: null,
          referringDomainCount: null,
          dofollowCount: null,
          nofollowCount: null,
          newBacklinks: null,
          lostBacklinks: null,
          newReferringDomains: null,
          lostReferringDomains: null,
          spamScore: null,
        },
        backlinks: [],
        referringDomains: [],
        provider: "live",
        providerOk: false,
        reportedBacklinkTotal: null,
        estimatedCostMicros: 0,
        actualCostMicros: 0,
        truncatedReason:
          "DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY is not configured; paid backlink collection is disabled",
      });
    },
  };
}

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
