import { DEFAULT_LIMITS, type FrontierLimits } from "./crawl-frontier";
import { DEFAULT_USER_AGENT, type FetchPolicy } from "./safe-fetch";

/**
 * Morgana Search Intelligence — Site Audit shared limits and shapes.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * The numbers that bound a crawl live in one place because they are the
 * subsystem's safety envelope, and an envelope spread across three modules is
 * one somebody will widen by accident.
 */

/**
 * Per-domain page ceilings. Raised deliberately, never automatically.
 *
 * Module-private on purpose: `pageLimitFor` below is the only way to arrive at
 * a page limit, so there is no call site that can pick a ceiling directly.
 */
const PRIMARY_PAGE_LIMIT = 500;
const COMPETITOR_PAGE_LIMIT = 200;
/** The initial activation ceiling: CheckSig only, 100 pages. */
const INITIAL_ACTIVATION_PAGE_LIMIT = 100;

export const CRAWL_DEADLINE_MS = 20 * 60 * 1000;
/** Pages per invocation. Two at a time, so a batch is a handful of round trips. */
export const BATCH_PAGES = 10;
/**
 * A courtesy to the site being crawled, not a throughput knob.
 *
 * One at a time. The crawler's only current target is our own site and the
 * batch is already small, so there is nothing to buy by doubling this — and a
 * serial crawl is the version whose load on someone else's server is trivially
 * predictable.
 */
export const CONCURRENCY = 1;
export const MANUAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface RunOutcome {
  runId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  reason?: string;
  pagesCrawled?: number;
  pagesRemaining?: number;
}

export interface CrawlDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * How many pages this run may crawl.
 *
 * The ceiling depends on the entity type, but the DEFAULT is the activation
 * limit, not the ceiling: an audit nobody sized explicitly crawls 100 pages.
 * The ceiling is what a caller may deliberately ask for, and the two are
 * separate on purpose — the first crawl of a 500-page site should not be the
 * accidental consequence of turning the scheduler on.
 */
export function pageLimitFor(
  entity: { entityType: string },
  configured?: number,
): number {
  const ceiling =
    entity.entityType === "primary"
      ? PRIMARY_PAGE_LIMIT
      : COMPETITOR_PAGE_LIMIT;
  const requested = configured ?? INITIAL_ACTIVATION_PAGE_LIMIT;
  return Math.max(1, Math.min(ceiling, requested));
}

export function limitsFor(pageLimit: number): FrontierLimits {
  return { ...DEFAULT_LIMITS, maxPages: pageLimit };
}

export function policyFor(
  entity: { normalizedDomain: string; includeSubdomains: boolean },
  fetchImpl?: typeof fetch,
): FetchPolicy {
  return {
    registrableDomain: entity.normalizedDomain,
    includeSubdomains: entity.includeSubdomains,
    userAgent: DEFAULT_USER_AGENT,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}
