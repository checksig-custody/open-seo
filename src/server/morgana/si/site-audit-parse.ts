/**
 * Morgana Search Intelligence — page, robots and sitemap parsing.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * A bounded, dependency-free extractor rather than a DOM. No JavaScript is
 * executed, no browser is rendered and nothing is fetched here — the input is
 * a string that `safe-fetch` already decided was safe to read, and everything
 * below is pure, which is what makes it testable outside a Worker isolate.
 *
 * It reads what a search engine reads from the HTML source: title, meta
 * description, headings, robots directives, canonical, links, images. It does
 * not attempt to be correct about malformed markup in the way a real parser is
 * — an audit that misreads a broken page still reports the page as broken.
 */

interface ParsedLink {
  href: string;
  anchor: string;
  rel: string | null;
}

interface ParsedPage {
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  robotsDirective: string | null;
  canonical: string | null;
  links: ParsedLink[];
  imageCount: number;
  imagesMissingAlt: number;
  invalidImageUrls: number;
  /** Visible text length: what "empty page" actually means. */
  textLength: number;
  /** Shingled fingerprint of the visible text. */
  contentHash: string;
}

const TAG_LIMIT = 3000;

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function clean(value: string | undefined | null, max = 512): string | null {
  if (value === undefined || value === null) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  return text === "" ? null : text.slice(0, max);
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(tag);
  return match ? (match[2] ?? match[3] ?? match[4] ?? null) : null;
}

/**
 * A SimHash of the visible text.
 *
 * Near-duplicate detection needs a fingerprint where a *small* edit produces a
 * *small* change, which is exactly what a cryptographic hash refuses to do. So
 * this is a 32-bit SimHash over word trigrams: each shingle votes on every bit,
 * and the sign of the vote is the bit. One rotating quote or a changed
 * timestamp moves a handful of votes, which flips at most a bit or two — and
 * `hammingDistance` below is what turns "a bit or two" into "the same page".
 *
 * An earlier version quantised per-bucket shingle counts. It looked equivalent
 * and was not: on a short page the counts are 1–3, so a single changed word
 * moved a bucket across a quantisation boundary and the two pages compared
 * unequal. The failure mode of a fuzzy fingerprint that is not actually fuzzy
 * is that the duplicate check silently never fires.
 */
function contentFingerprint(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
  if (words.length < 3) return "empty";

  const votes = new Int32Array(32);
  for (let index = 0; index + 2 < words.length; index += 1) {
    const shingle = `${words[index] ?? ""} ${words[index + 1] ?? ""} ${words[index + 2] ?? ""}`;
    let hash = 2166136261;
    for (let position = 0; position < shingle.length; position += 1) {
      hash ^= shingle.charCodeAt(position);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    for (let bit = 0; bit < 32; bit += 1) {
      votes[bit] = (votes[bit] ?? 0) + ((hash >>> bit) & 1 ? 1 : -1);
    }
  }

  let fingerprint = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if ((votes[bit] ?? 0) > 0) fingerprint |= 1 << bit;
  }
  return (fingerprint >>> 0).toString(16).padStart(8, "0");
}

/**
 * How many bits two fingerprints differ by.
 *
 * The threshold lives with the caller, not here: "how similar is similar
 * enough" is a product judgement, and burying it in the hash would make it
 * invisible.
 */
export function hammingDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "empty" || b === "empty") return 32;
  const left = Number.parseInt(a, 16);
  const right = Number.parseInt(b, 16);
  if (Number.isNaN(left) || Number.isNaN(right)) return 32;
  let xor = (left ^ right) >>> 0;
  let distance = 0;
  while (xor !== 0) {
    distance += xor & 1;
    xor >>>= 1;
  }
  return distance;
}

function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

export function parseHtml(html: string): ParsedPage {
  const source = html.slice(0, 2 * 1024 * 1024);
  const withoutCode = stripNonContent(source);

  const title = clean(
    /<title[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(source)?.[1],
    300,
  );

  let metaDescription: string | null = null;
  let robotsDirective: string | null = null;
  const metaTags = source.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags.slice(0, TAG_LIMIT)) {
    const name = attribute(tag, "name")?.toLowerCase();
    if (name === "description" && metaDescription === null) {
      metaDescription = clean(attribute(tag, "content"), 400);
    }
    // Both the generic and the Google-specific directive count: a `noindex` in
    // either one keeps the page out of the index.
    if (
      (name === "robots" || name === "googlebot") &&
      robotsDirective === null
    ) {
      robotsDirective =
        clean(attribute(tag, "content"), 200)?.toLowerCase() ?? null;
    }
  }

  const h1s: string[] = [];
  for (const match of source.matchAll(/<h1\b[^>]*>([\s\S]{0,600}?)<\/h1>/gi)) {
    const text = clean(match[1]?.replace(/<[^>]+>/g, " "), 300);
    if (text) h1s.push(text);
    if (h1s.length >= 20) break;
  }

  let canonical: string | null = null;
  for (const tag of (source.match(/<link\b[^>]*>/gi) ?? []).slice(
    0,
    TAG_LIMIT,
  )) {
    const rel = attribute(tag, "rel")?.toLowerCase();
    if (rel === "canonical") {
      canonical = clean(attribute(tag, "href"), 2048);
      break;
    }
  }

  const links: ParsedLink[] = [];
  for (const match of withoutCode.matchAll(
    /<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi,
  )) {
    const tag = match[1] ?? "";
    const href = attribute(tag, "href");
    if (!href) continue;
    const trimmed = href.trim();
    // Anchors, mailto:, tel:, javascript: are not pages to crawl.
    if (
      trimmed === "" ||
      trimmed.startsWith("#") ||
      /^(mailto|tel|javascript|data|ftp|file):/i.test(trimmed)
    ) {
      continue;
    }
    links.push({
      href: decodeEntities(trimmed).slice(0, 2048),
      anchor: clean(match[2]?.replace(/<[^>]+>/g, " "), 200) ?? "",
      rel: attribute(tag, "rel")?.toLowerCase().slice(0, 100) ?? null,
    });
    if (links.length >= 1500) break;
  }

  let imageCount = 0;
  let imagesMissingAlt = 0;
  let invalidImageUrls = 0;
  for (const tag of (withoutCode.match(/<img\b[^>]*>/gi) ?? []).slice(
    0,
    TAG_LIMIT,
  )) {
    imageCount += 1;
    const alt = attribute(tag, "alt");
    // An absent alt and an empty alt are different: `alt=""` is the correct
    // markup for a decorative image and is not a defect.
    if (alt === null) imagesMissingAlt += 1;
    const src = attribute(tag, "src") ?? attribute(tag, "data-src");
    if (!src || src.trim() === "" || src.trim().startsWith("#")) {
      invalidImageUrls += 1;
    }
  }

  const text = decodeEntities(withoutCode.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

  return {
    title,
    metaDescription,
    h1s,
    robotsDirective,
    canonical,
    links,
    imageCount,
    imagesMissingAlt,
    invalidImageUrls,
    textLength: text.length,
    contentHash: contentFingerprint(text),
  };
}

// --- robots.txt --------------------------------------------------------------

export interface RobotsRules {
  /** Paths disallowed for our user agent (or for `*`). */
  disallow: string[];
  allow: string[];
  sitemaps: string[];
  crawlDelaySeconds: number | null;
}

/**
 * Parse robots.txt for our agent.
 *
 * Group selection follows the standard: a group naming our agent wins over the
 * wildcard group entirely — it does not merge with it. Getting that wrong would
 * make a site that specifically permits us look like one that forbids us.
 */
export function parseRobots(
  text: string,
  userAgent = "morgana-site-audit",
): RobotsRules {
  const rules: RobotsRules = {
    disallow: [],
    allow: [],
    sitemaps: [],
    crawlDelaySeconds: null,
  };
  const wildcard: Omit<RobotsRules, "sitemaps"> = {
    disallow: [],
    allow: [],
    crawlDelaySeconds: null,
  };
  const specific: Omit<RobotsRules, "sitemaps"> = {
    disallow: [],
    allow: [],
    crawlDelaySeconds: null,
  };

  let applyingTo: "none" | "wildcard" | "specific" = "none";
  let sawSpecific = false;
  const lines = text.slice(0, 200_000).split(/\r?\n/).slice(0, 5000);

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      const agent = value.toLowerCase();
      if (agent === "*") applyingTo = "wildcard";
      else if (userAgent.includes(agent) || agent.includes(userAgent)) {
        applyingTo = "specific";
        sawSpecific = true;
      } else applyingTo = "none";
      continue;
    }
    if (field === "sitemap") {
      if (rules.sitemaps.length < 20) rules.sitemaps.push(value.slice(0, 2048));
      continue;
    }
    if (applyingTo === "none") continue;
    const target = applyingTo === "specific" ? specific : wildcard;
    if (field === "disallow" && value !== "") {
      if (target.disallow.length < 500)
        target.disallow.push(value.slice(0, 500));
    } else if (field === "allow" && value !== "") {
      if (target.allow.length < 500) target.allow.push(value.slice(0, 500));
    } else if (field === "crawl-delay") {
      const parsed = Number(value);
      if (Number.isFinite(parsed))
        target.crawlDelaySeconds = Math.min(60, parsed);
    }
  }

  const chosen = sawSpecific ? specific : wildcard;
  rules.disallow = chosen.disallow;
  rules.allow = chosen.allow;
  rules.crawlDelaySeconds = chosen.crawlDelaySeconds;
  return rules;
}

/** Longest-match wins, and an equal-length Allow beats Disallow. */
export function robotsAllows(rules: RobotsRules, pathname: string): boolean {
  const match = (patterns: string[]): number => {
    let best = -1;
    for (const pattern of patterns) {
      // `*` and `$` are the only wildcards robots.txt defines.
      const regex = new RegExp(
        `^${pattern
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replace(/\\\$$/, "$")}`,
      );
      if (regex.test(pathname)) best = Math.max(best, pattern.length);
    }
    return best;
  };
  const disallowed = match(rules.disallow);
  if (disallowed === -1) return true;
  return match(rules.allow) >= disallowed;
}

// --- sitemap -----------------------------------------------------------------

interface ParsedSitemap {
  urls: string[];
  /** Nested sitemaps from a sitemap index. */
  sitemaps: string[];
  valid: boolean;
}

export function parseSitemap(xml: string, limit = 5000): ParsedSitemap {
  const source = xml.slice(0, 4 * 1024 * 1024);
  const isIndex = /<sitemapindex[\s>]/i.test(source);
  const hasUrlset = /<urlset[\s>]/i.test(source);
  if (!isIndex && !hasUrlset) {
    return { urls: [], sitemaps: [], valid: false };
  }
  const locations: string[] = [];
  for (const match of source.matchAll(
    /<loc>\s*([\s\S]{0,2048}?)\s*<\/loc>/gi,
  )) {
    const value = decodeEntities((match[1] ?? "").trim());
    if (value) locations.push(value);
    if (locations.length >= limit) break;
  }
  return {
    urls: isIndex ? [] : locations,
    sitemaps: isIndex ? locations.slice(0, 50) : [],
    valid: true,
  };
}
