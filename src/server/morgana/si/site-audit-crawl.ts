import { isEnabled, type Phase0Config } from "../phase0-env";
import * as entities from "./store";
import * as store from "./site-audit-store";
import * as issueStore from "./site-audit-issue-store";
import { newId, nowIso } from "./ids";
import {
  canonicalizeUrl,
  FrontierGuard,
  hasBlockedExtension,
} from "./crawl-frontier";
import { hostInScope, safeFetch, type SafeFetchResult } from "./safe-fetch";
import { parseHtml, robotsAllows, type RobotsRules } from "./site-audit-parse";
import { isNoindex, type PageFacts } from "./site-audit-checks";
import { finishRun } from "./site-audit-finalize";
import { readRobots, startRun } from "./site-audit-start";
import {
  BATCH_PAGES,
  CONCURRENCY,
  CRAWL_DEADLINE_MS,
  limitsFor,
  policyFor,
  type CrawlDeps,
  type RunOutcome,
} from "./site-audit-shared";

/**
 * Morgana Search Intelligence — the crawl loop.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * One bounded batch per invocation. A Worker request cannot hold a 500-page
 * crawl open, so the frontier lives in the database and the run is resumed by
 * the next tick — which is why an interrupted crawl is a `partial` run rather
 * than a lost one.
 */

interface DiscoveryInput {
  runId: string;
  sourceUrl: string;
  depth: number;
  links: readonly { href: string; anchor: string; rel: string | null }[];
  scope: { registrableDomain: string; includeSubdomains: boolean };
  guard: FrontierGuard;
}

/**
 * Record a page's links and queue the ones we are allowed to follow.
 *
 * Extracted from the batch loop so the loop stays readable: the admission
 * decision for a discovered link is a rule of its own, not a detail of how the
 * batch is iterated.
 */
async function recordDiscoveries(input: DiscoveryInput): Promise<void> {
  const { runId, sourceUrl, depth, links, scope, guard } = input;

  const rows = links.slice(0, 500).map((link) => {
    const canonical = canonicalizeUrl(link.href, sourceUrl);
    let host = "";
    try {
      host = canonical ? new URL(canonical).hostname : "";
    } catch {
      host = "";
    }
    const internal =
      host !== "" &&
      hostInScope(host, scope.registrableDomain, scope.includeSubdomains);
    return {
      sourceUrl,
      targetUrl: canonical ?? link.href,
      anchorText: link.anchor || null,
      linkType: internal ? ("internal" as const) : ("external" as const),
      rel: link.rel,
    };
  });
  await store.saveLinks(runId, rows);

  const discovered: Parameters<typeof store.enqueue>[1][number][] = [];
  for (const link of links) {
    const decision = guard.consider(link.href, depth + 1, sourceUrl);
    if (decision.accepted && decision.canonical) {
      discovered.push({
        normalizedUrl: decision.canonical,
        depth: depth + 1,
        discoveredFrom: sourceUrl,
        discoverySource: "link",
      });
    }
  }
  if (discovered.length > 0) await store.enqueue(runId, discovered);
}

interface FactsInput {
  url: string;
  result: SafeFetchResult;
  depth: number;
  parsed: ReturnType<typeof parseHtml> | null;
  scope: { registrableDomain: string; includeSubdomains: boolean };
  isHomepage: boolean;
  inSitemap: boolean;
}

/** A context object, not seven positional arguments the caller must order. */
function factsFrom(input: FactsInput): PageFacts {
  const { url, result, depth, parsed, scope, isHomepage, inSitemap } = input;
  let internal = 0;
  let external = 0;
  if (parsed) {
    for (const link of parsed.links) {
      const canonical = canonicalizeUrl(link.href, url);
      if (!canonical) continue;
      let host = "";
      try {
        host = new URL(canonical).hostname;
      } catch {
        continue;
      }
      if (hostInScope(host, scope.registrableDomain, scope.includeSubdomains)) {
        internal += 1;
      } else external += 1;
    }
  }
  return {
    url,
    normalizedUrl: url,
    statusCode: result.status ?? null,
    contentType: result.contentType ?? null,
    responseTimeMs: result.responseTimeMs,
    depth,
    title: parsed?.title ?? null,
    metaDescription: parsed?.metaDescription ?? null,
    h1s: parsed?.h1s ?? [],
    robotsDirective: parsed?.robotsDirective ?? null,
    canonical: parsed?.canonical ?? null,
    textLength: parsed?.textLength ?? 0,
    contentHash: parsed?.contentHash ?? null,
    internalLinkCount: internal,
    externalLinkCount: external,
    imageCount: parsed?.imageCount ?? 0,
    imagesMissingAlt: parsed?.imagesMissingAlt ?? 0,
    invalidImageUrls: parsed?.invalidImageUrls ?? 0,
    redirectChain: result.redirectChain,
    finalUrl: result.finalUrl ?? null,
    inSitemap,
    fetchError: result.ok
      ? null
      : (result.reason ?? result.blocked ?? "fetch failed"),
    blocked: result.blocked ?? null,
    isHomepage,
  };
}

/** Indexability, with the reason kept — "not indexable" needs a because. */
function indexability(facts: PageFacts): {
  indexable: boolean | null;
  reason: string | null;
} {
  if (facts.statusCode === null)
    return { indexable: null, reason: "not fetched" };
  if (facts.statusCode >= 400) {
    return { indexable: false, reason: `http ${String(facts.statusCode)}` };
  }
  if (isNoindex(facts.robotsDirective)) {
    return { indexable: false, reason: "noindex directive" };
  }
  return { indexable: true, reason: null };
}

/**
 * Process one batch of the frontier.
 *
 * Returns when the batch is done, the deadline has passed or the frontier is
 * empty. The caller decides whether to come back for more, which is what keeps
 * a crawl inside a Worker's budget.
 */
export async function runAuditBatch(
  config: Phase0Config,
  runId: string,
  deps: CrawlDeps = {},
): Promise<RunOutcome> {
  if (!isEnabled(config.SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED)) {
    return { runId, status: "skipped", reason: "site audit is disabled" };
  }
  const run = await store.getRun(runId);
  if (!run) return { runId, status: "skipped", reason: "unknown run" };
  if (run.status === "completed" || run.status === "failed") {
    return { runId, status: run.status };
  }
  const entity = await entities.getEntity(run.entityId);
  if (!entity) {
    await store.updateRun(runId, {
      status: "failed",
      stopReason: "error",
      lastError: "entity disappeared",
      completedAt: nowIso(),
    });
    return { runId, status: "failed", reason: "unknown entity" };
  }

  const policy = policyFor(entity, deps.fetchImpl);
  const scope = {
    registrableDomain: entity.normalizedDomain,
    includeSubdomains: entity.includeSubdomains,
  };
  let robots: RobotsRules = {
    disallow: [],
    allow: [],
    sitemaps: [],
    crawlDelaySeconds: null,
  };
  let sitemapUrls = new Set<string>();

  if (run.status === "queued") {
    const started = await startRun(run, entity, policy);
    robots = started.robots;
    sitemapUrls = new Set(
      started.sitemapUrls
        .map((url) => canonicalizeUrl(url))
        .filter((url): url is string => url !== null),
    );
  } else {
    // On a resumed batch robots is re-read; an unreadable file leaves the
    // existing rules in place rather than widening them.
    const reread = await readRobots(
      `https://${entity.normalizedDomain}`,
      policy,
    );
    if (reread) robots = reread;
  }

  const deadline = run.deadlineAt
    ? new Date(run.deadlineAt).getTime()
    : Date.now() + CRAWL_DEADLINE_MS;
  const now = deps.now ?? Date.now;

  const known = await store.knownUrls(runId);
  const guard = new FrontierGuard(limitsFor(run.pageLimit), scope, known);

  let pagesCrawled = run.pagesCrawled;
  let pagesFailed = run.pagesFailed;
  let pagesBlocked = run.pagesBlocked;
  let requests = 0;
  let bytes = 0;
  let errors = 0;
  const batchStarted = now();

  const batch = await store.nextBatch(runId, BATCH_PAGES);
  if (batch.length === 0) {
    return finishRun(runId, "completed");
  }
  await store.markFrontier(
    batch.map((entry) => entry.id),
    "in_progress",
  );

  // Two at a time per domain: the concurrency limit is a courtesy to the site
  // being crawled, not a throughput knob.
  for (let offset = 0; offset < batch.length; offset += CONCURRENCY) {
    if (now() > deadline) break;
    const slice = batch.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (entry) => {
        let pathname = "/";
        try {
          pathname = new URL(entry.normalizedUrl).pathname;
        } catch {
          pathname = "/";
        }
        // robots.txt is honoured by default. A disallowed URL is recorded as
        // blocked with its reason rather than silently dropped.
        if (!robotsAllows(robots, pathname)) {
          return { entry, blockedByRobots: true, result: null };
        }
        if (hasBlockedExtension(pathname)) {
          return { entry, blockedByRobots: false, result: null, nonHtml: true };
        }
        const result = await safeFetch(entry.normalizedUrl, policy);
        return { entry, blockedByRobots: false, result };
      }),
    );

    for (const outcome of results) {
      const { entry, result } = outcome;
      if (!result) {
        pagesBlocked += 1;
        await store.markFrontier(
          [entry.id],
          "blocked",
          outcome.blockedByRobots ? "robots.txt disallow" : "non-html resource",
        );
        continue;
      }
      requests += 1;
      bytes += result.bytes;

      const parsed =
        result.ok && result.body && /html|xml/i.test(result.contentType ?? "")
          ? parseHtml(result.body)
          : null;
      const facts = factsFrom({
        url: entry.normalizedUrl,
        result,
        depth: entry.depth,
        parsed,
        scope,
        isHomepage: entry.depth === 0,
        inSitemap: sitemapUrls.has(entry.normalizedUrl),
      });
      const index = indexability(facts);

      await store.savePage({
        id: newId("sap"),
        runId,
        entityId: run.entityId,
        url: entry.normalizedUrl,
        normalizedUrl: entry.normalizedUrl,
        canonicalUrl: parsed?.canonical
          ? canonicalizeUrl(parsed.canonical, entry.normalizedUrl)
          : null,
        statusCode: facts.statusCode,
        contentType: facts.contentType,
        responseTimeMs: facts.responseTimeMs,
        depth: entry.depth,
        title: facts.title,
        metaDescription: facts.metaDescription,
        h1Count: facts.h1s.length,
        firstH1: facts.h1s[0] ?? null,
        robotsDirective: facts.robotsDirective,
        indexable: index.indexable,
        indexabilityReason: index.reason,
        contentLength: result.bytes,
        textLength: facts.textLength,
        internalLinkCount: facts.internalLinkCount,
        externalLinkCount: facts.externalLinkCount,
        imageCount: facts.imageCount,
        imagesMissingAlt: facts.imagesMissingAlt,
        contentHash: facts.contentHash,
        redirectChainLength: result.redirectChain.length,
        finalUrl: result.finalUrl ?? null,
        inSitemap: facts.inSitemap,
        fetchError: facts.fetchError,
        crawledAt: nowIso(),
      });

      if (result.ok) pagesCrawled += 1;
      else {
        pagesFailed += 1;
        errors += 1;
      }
      await store.markFrontier([entry.id], "done");

      if (parsed) {
        await recordDiscoveries({
          runId,
          sourceUrl: entry.normalizedUrl,
          depth: entry.depth,
          links: parsed.links,
          scope,
          guard,
        });
      }
    }
  }

  const durationMs = now() - batchStarted;
  await issueStore.recordUsage({
    entityId: run.entityId,
    runId,
    requests,
    pagesProcessed: batch.length,
    bytesFetched: bytes,
    durationMs,
    errors,
    blocked: pagesBlocked - run.pagesBlocked,
  });
  await store.updateRun(runId, {
    pagesCrawled,
    pagesFailed,
    pagesBlocked,
    pagesDiscovered: guard.size,
    requestsMade: run.requestsMade + requests,
    bytesFetched: run.bytesFetched + bytes,
    durationMs: run.durationMs + durationMs,
  });

  const counts = await store.frontierCounts(runId);
  const remaining = counts.pending ?? 0;

  if (remaining === 0) return finishRun(runId, "completed");
  if (now() > deadline) return finishRun(runId, "time_limit");
  if (pagesCrawled >= run.pageLimit) return finishRun(runId, "page_limit");

  return { runId, status: "running", pagesCrawled, pagesRemaining: remaining };
}

/**
 * Close a run: classify, score, diff, and decide comparability.
 *
 * `comparison_status` is set here and only here. `complete` requires the crawl
 * to have ended because it ran out of pages to visit — a page limit, a
 * deadline or an error all produce `partial`, and the diff will not resolve
 * anything from a partial run.
 */
