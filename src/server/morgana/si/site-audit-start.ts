import * as store from "./site-audit-store";
import * as issueStore from "./site-audit-issue-store";
import { nowIso } from "./ids";
import { canonicalizeUrl, FrontierGuard } from "./crawl-frontier";
import {
  safeFetch,
  type FetchPolicy,
  type SafeFetchResult,
} from "./safe-fetch";
import {
  parseRobots,
  parseSitemap,
  type RobotsRules,
} from "./site-audit-parse";
import { CRAWL_DEADLINE_MS, limitsFor } from "./site-audit-shared";

/**
 * Morgana Search Intelligence — everything a crawl does once, at its start.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * robots.txt and the sitemap are read here and nowhere else, and the frontier
 * is seeded from them before the first page is fetched. Split out of
 * `site-audit-crawl.ts` so the batch loop is only the batch loop.
 *
 * Both discovery steps are bounded on purpose: at most two sitemap candidates
 * and one nested child, because a sitemap index pointing at fifty children
 * would otherwise be a crawl of its own before the real crawl began.
 */

async function fetchText(
  url: string,
  policy: FetchPolicy,
): Promise<SafeFetchResult> {
  return safeFetch(url, policy);
}

/**
 * Re-read robots.txt on a resumed batch.
 *
 * One request, and honouring a rule the site added mid-crawl matters more than
 * saving it. Returns null when the file could not be read, which leaves the
 * caller's existing rules in place rather than widening them.
 */
export async function readRobots(
  origin: string,
  policy: FetchPolicy,
): Promise<RobotsRules | null> {
  const result = await fetchText(`${origin}/robots.txt`, policy);
  return result.ok && result.body ? parseRobots(result.body) : null;
}

/** robots.txt and the sitemap, fetched once per run when it starts. */
async function discoverSite(
  origin: string,
  policy: FetchPolicy,
): Promise<{
  robots: RobotsRules;
  robotsStatus: "ok" | "missing" | "invalid";
  sitemapUrls: string[];
  sitemapStatus: "ok" | "missing" | "invalid";
  requests: number;
  bytes: number;
}> {
  let robots: RobotsRules = {
    disallow: [],
    allow: [],
    sitemaps: [],
    crawlDelaySeconds: null,
  };
  let robotsStatus: "ok" | "missing" | "invalid" = "missing";
  let requests = 0;
  let bytes = 0;

  const robotsResult = await fetchText(`${origin}/robots.txt`, policy);
  requests += 1;
  bytes += robotsResult.bytes;
  if (robotsResult.ok && robotsResult.status === 200 && robotsResult.body) {
    robots = parseRobots(robotsResult.body);
    robotsStatus = "ok";
  } else if (robotsResult.ok && robotsResult.status === 404) {
    // No robots.txt means no restrictions, which is a valid site, not a fault.
    robotsStatus = "missing";
  } else if (robotsResult.ok) {
    robotsStatus = "invalid";
  }

  const candidates =
    robots.sitemaps.length > 0 ? robots.sitemaps : [`${origin}/sitemap.xml`];
  const sitemapUrls: string[] = [];
  let sitemapStatus: "ok" | "missing" | "invalid" = "missing";

  // Bounded: at most three sitemap documents per run, index included. A sitemap
  // index pointing at fifty children would otherwise be its own crawl.
  for (const candidate of candidates.slice(0, 2)) {
    const result = await fetchText(candidate, policy);
    requests += 1;
    bytes += result.bytes;
    if (!result.ok || result.status !== 200 || !result.body) continue;
    const parsed = parseSitemap(result.body);
    if (!parsed.valid) {
      sitemapStatus = "invalid";
      continue;
    }
    sitemapStatus = "ok";
    sitemapUrls.push(...parsed.urls);
    for (const nested of parsed.sitemaps.slice(0, 1)) {
      const child = await fetchText(nested, policy);
      requests += 1;
      bytes += child.bytes;
      if (child.ok && child.status === 200 && child.body) {
        sitemapUrls.push(...parseSitemap(child.body).urls);
      }
    }
  }

  return {
    robots,
    robotsStatus,
    sitemapUrls: sitemapUrls.slice(0, 2000),
    sitemapStatus,
    requests,
    bytes,
  };
}

interface StartResult {
  origin: string;
  robots: RobotsRules;
  robotsStatus: "ok" | "missing" | "invalid";
  sitemapStatus: "ok" | "missing" | "invalid";
  sitemapUrls: string[];
}

export async function startRun(
  run: store.AuditRunRow,
  entity: { normalizedDomain: string; includeSubdomains: boolean },
  policy: FetchPolicy,
): Promise<StartResult> {
  const origin = `https://${entity.normalizedDomain}`;
  const discovery = await discoverSite(origin, policy);
  const guard = new FrontierGuard(limitsFor(run.pageLimit), {
    registrableDomain: entity.normalizedDomain,
    includeSubdomains: entity.includeSubdomains,
  });

  const seedUrl = canonicalizeUrl(origin);
  const queued: Parameters<typeof store.enqueue>[1][number][] = [];
  if (seedUrl) {
    guard.consider(seedUrl, 0);
    queued.push({
      normalizedUrl: seedUrl,
      depth: 0,
      discoverySource: "seed",
    });
  }
  for (const url of discovery.sitemapUrls) {
    const decision = guard.consider(url, 1);
    if (decision.accepted && decision.canonical) {
      queued.push({
        normalizedUrl: decision.canonical,
        depth: 1,
        discoverySource: "sitemap",
      });
    }
  }

  await store.enqueue(run.id, queued);
  await store.updateRun(run.id, {
    status: "running",
    startedAt: nowIso(),
    deadlineAt: new Date(Date.now() + CRAWL_DEADLINE_MS).toISOString(),
    robotsStatus: discovery.robotsStatus,
    sitemapStatus: discovery.sitemapStatus,
    pagesDiscovered: queued.length,
    requestsMade: discovery.requests,
    bytesFetched: discovery.bytes,
  });
  await issueStore.recordUsage({
    entityId: run.entityId,
    runId: run.id,
    requests: discovery.requests,
    bytesFetched: discovery.bytes,
  });

  return {
    origin,
    robots: discovery.robots,
    robotsStatus: discovery.robotsStatus,
    sitemapStatus: discovery.sitemapStatus,
    sitemapUrls: discovery.sitemapUrls,
  };
}
