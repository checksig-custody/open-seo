import { hostInScope, normalizeHost } from "./safe-fetch";

/**
 * Morgana Search Intelligence — URL canonicalization and crawl-trap containment.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * Pure functions, no I/O, no database, no Worker binding — so the rules that
 * decide what gets crawled are testable on their own. Phase 3 learned this the
 * hard way: logic that drags `cloudflare:workers` into its import graph cannot
 * be tested outside an isolate.
 *
 * Two jobs:
 *
 * **Canonicalization** turns many spellings of one page into one key. Without
 * it a crawl re-fetches the same page under `?utm_source=…`, a trailing slash
 * and a capitalised host, and the page budget is gone before the site is.
 *
 * **Trap containment** bounds the shapes that are infinite by construction —
 * calendars, filter combinations, session ids, paginated infinity. The upstream
 * crawler's weakness is exactly here: unbounded query-parameter variants, which
 * is why the variant cap below is per path and not per site.
 */

/**
 * Tracking parameters removed unconditionally.
 *
 * Removing a *functional* parameter would merge two genuinely different pages,
 * so this list stays deliberately conservative: analytics and ad-click ids
 * only. Anything ambiguous is kept.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "ref_src",
  "igshid",
]);

/**
 * Parameters that identify a session rather than a page.
 *
 * Their presence is itself a trap signal: every visit mints a new value, so a
 * crawler that keeps them re-crawls the whole site once per session.
 */
const SESSION_PARAMS: ReadonlySet<string> = new Set([
  "sessionid",
  "session_id",
  "sid",
  "phpsessid",
  "jsessionid",
  "aspsessionid",
  "cfid",
  "cftoken",
]);

/** Extensions we never fetch: the body would be binary and large. */
const BLOCKED_EXTENSIONS = [
  ".pdf",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".mp3",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".exe",
  ".dmg",
  ".apk",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".css",
  ".js",
  ".map",
];

export function hasBlockedExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return BLOCKED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Canonical form of a URL, for dedupe.
 *
 * Lowercased scheme and host, default port dropped, fragment dropped, tracking
 * and session parameters removed, remaining parameters sorted, and a trailing
 * slash removed from everything except the root. Sorting matters: `?a=1&b=2`
 * and `?b=2&a=1` are one page, and without sorting they are two.
 */
export function canonicalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.username = "";
  url.password = "";
  url.hostname = normalizeHost(url.hostname);
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const kept: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower)) continue;
    if (SESSION_PARAMS.has(lower)) continue;
    kept.push([key, value]);
  }
  kept.sort((a, b) =>
    a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
  );
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  // Repeated slashes are the same path to every server that matters, and
  // leaving them in is a cheap way to mint infinite distinct URLs.
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");

  return url.toString();
}

/** The path, ignoring the query — the bucket the variant cap counts against. */
export function pathKey(canonical: string): string {
  try {
    const url = new URL(canonical);
    return `${url.origin}${url.pathname}`;
  } catch {
    return canonical;
  }
}

interface TrapVerdict {
  trapped: boolean;
  reason?: string;
}

/** Path segments that repeat, e.g. `/a/b/a/b/a/b` from a bad relative link. */
function hasRepeatingSegments(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 6) return false;
  const seen = new Map<string, number>();
  for (const segment of segments) {
    const count = (seen.get(segment) ?? 0) + 1;
    if (count >= 3) return true;
    seen.set(segment, count);
  }
  return false;
}

const CALENDAR_HINTS = [
  "calendar",
  "calendario",
  "eventi",
  "events",
  "agenda",
  "archive",
  "archivio",
];

const FILTER_HINTS = [
  "filter",
  "filtro",
  "filter_by",
  "orderby",
  "order_by",
  "sort",
  "sort_by",
  "facet",
  "price_min",
  "price_max",
  "colour",
  "color",
  "size",
  "taglia",
];

/**
 * Does this URL look like an infinite space rather than a page?
 *
 * Heuristics, and they are allowed to be wrong in the safe direction: skipping
 * a real page costs one row of coverage, while entering a calendar costs the
 * entire crawl budget and produces nothing.
 */
export function detectTrap(canonical: string): TrapVerdict {
  let url: URL;
  try {
    url = new URL(canonical);
  } catch {
    return { trapped: true, reason: "unparseable" };
  }

  const params = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  if (params.length > 4) {
    return {
      trapped: true,
      reason: `${String(params.length)} query parameters`,
    };
  }
  const filterParams = params.filter((key) =>
    FILTER_HINTS.some((hint) => key === hint || key.startsWith(hint)),
  );
  // One filter is a category page; two combined is the start of a combinatorial
  // explosion, and every additional one multiplies it.
  if (filterParams.length >= 2) {
    return { trapped: true, reason: "combined filter parameters" };
  }

  const lowerPath = url.pathname.toLowerCase();
  const calendarish = CALENDAR_HINTS.some((hint) => lowerPath.includes(hint));
  const hasDateParam = params.some((key) =>
    ["date", "day", "month", "year", "week", "data", "mese", "anno"].includes(
      key,
    ),
  );
  if (calendarish && hasDateParam) {
    return { trapped: true, reason: "calendar navigation" };
  }
  // /2026/08/06/ style archive drilldowns, three levels deep or more.
  if (/\/\d{4}\/\d{1,2}\/\d{1,2}(\/|$)/.test(lowerPath) && calendarish) {
    return { trapped: true, reason: "dated archive path" };
  }

  const pageParam =
    url.searchParams.get("page") ??
    url.searchParams.get("pagina") ??
    url.searchParams.get("p");
  if (pageParam !== null) {
    const parsed = Number.parseInt(pageParam, 10);
    // Deep pagination is real content in principle; past this point it is
    // almost always the same items resorted.
    if (Number.isNaN(parsed) || parsed > 20) {
      return { trapped: true, reason: "deep pagination" };
    }
  }

  if (hasRepeatingSegments(url.pathname)) {
    return { trapped: true, reason: "repeating path segments" };
  }
  if (url.pathname.length > 512) {
    return { trapped: true, reason: "path too long" };
  }
  return { trapped: false };
}

export interface FrontierLimits {
  maxPages: number;
  maxDepth: number;
  /** How many query-string variants of ONE path may be crawled. */
  maxVariantsPerPath: number;
}

export const DEFAULT_LIMITS: FrontierLimits = {
  maxPages: 100,
  maxDepth: 5,
  maxVariantsPerPath: 5,
};

interface CandidateDecision {
  accepted: boolean;
  canonical?: string;
  reason?: string;
}

/**
 * In-memory admission control for one batch of discovered links.
 *
 * The persisted frontier holds the queue; this decides what is even allowed to
 * join it. Keeping the decision here — pure, with the counters passed in —
 * means the rules can be tested without a database.
 */
export class FrontierGuard {
  private readonly seen = new Set<string>();
  private readonly variants = new Map<string, number>();

  constructor(
    private readonly limits: FrontierLimits,
    private readonly scope: {
      registrableDomain: string;
      includeSubdomains: boolean;
    },
    seed: readonly string[] = [],
  ) {
    for (const url of seed) {
      const canonical = canonicalizeUrl(url);
      if (!canonical) continue;
      this.seen.add(canonical);
      this.variants.set(pathKey(canonical), 1);
    }
  }

  get size(): number {
    return this.seen.size;
  }

  has(canonical: string): boolean {
    return this.seen.has(canonical);
  }

  /**
   * Should this discovered link be crawled?
   *
   * Order matters: cheap syntactic refusals first, scope next, then the
   * counters. Every refusal carries a reason, because "why is this page missing
   * from the audit" must be answerable from the crawl details.
   */
  consider(rawUrl: string, depth: number, base?: string): CandidateDecision {
    const canonical = canonicalizeUrl(rawUrl, base);
    if (!canonical) return { accepted: false, reason: "unparseable" };
    if (this.seen.has(canonical)) {
      return { accepted: false, canonical, reason: "already queued" };
    }

    let host: string;
    try {
      host = new URL(canonical).hostname;
    } catch {
      return { accepted: false, reason: "unparseable" };
    }
    if (
      !hostInScope(
        host,
        this.scope.registrableDomain,
        this.scope.includeSubdomains,
      )
    ) {
      return { accepted: false, canonical, reason: "external link" };
    }
    if (hasBlockedExtension(new URL(canonical).pathname)) {
      return { accepted: false, canonical, reason: "non-html resource" };
    }
    if (depth > this.limits.maxDepth) {
      return { accepted: false, canonical, reason: "max depth reached" };
    }
    if (this.seen.size >= this.limits.maxPages) {
      return { accepted: false, canonical, reason: "page limit reached" };
    }

    const trap = detectTrap(canonical);
    if (trap.trapped) {
      return {
        accepted: false,
        canonical,
        reason: `crawl trap: ${trap.reason ?? "unknown"}`,
      };
    }

    const key = pathKey(canonical);
    const variantCount = this.variants.get(key) ?? 0;
    if (variantCount >= this.limits.maxVariantsPerPath) {
      return {
        accepted: false,
        canonical,
        reason: "too many query variants of one path",
      };
    }

    this.seen.add(canonical);
    this.variants.set(key, variantCount + 1);
    return { accepted: true, canonical };
  }
}
