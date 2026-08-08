import { normalizeBacklinkDomain } from "./backlink-normalize";
import type {
  BacklinkProvider,
  RawBacklink,
  RawReferringDomain,
} from "./backlink-provider";

/**
 * Morgana Search Intelligence — the deterministic fixture backlink provider.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Split from `backlink-provider.ts` because that file had grown past the
 * repository's module size limit, and live-versus-fixture is the seam it was
 * always going to split on: two independent implementations of one interface
 * that happened to share a file. Nothing here can reach a provider, which is
 * the property that makes it safe to keep in the bundle — and production
 * refuses this path outright rather than relying on that.
 */

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
