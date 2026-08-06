/**
 * Morgana Search Intelligence — network admission control.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * The decisions the crawler makes BEFORE a request exists: is this a URL we may
 * fetch at all, and does the name it carries resolve somewhere we are allowed
 * to talk to. Split from `safe-fetch.ts` so the rules can be read — and tested —
 * without the transport around them.
 *
 * Allow-list, never deny-list: a deny-list is a list of the attacks someone
 * already thought of.
 */

export type DnsResolver = (hostname: string) => Promise<string[]>;

/** The only thing an admission decision needs to know about the crawl. */
interface CrawlScope {
  registrableDomain: string;
  includeSubdomains: boolean;
}

export type BlockReason =
  | "scheme_not_allowed"
  | "port_not_allowed"
  | "credentials_in_url"
  | "ip_literal_host"
  | "host_out_of_scope"
  | "invalid_host"
  | "dns_unresolved"
  | "private_address"
  | "too_many_redirects"
  | "response_too_large"
  | "content_type_not_allowed"
  | "timeout"
  | "network_error"
  | "robots_denied";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);

/**
 * Content types the crawler will read.
 *
 * An allow-list because the point of the crawl is HTML, XML and text. A PDF or
 * a video is not "a page we failed to parse", it is a download we must never
 * start — and the check runs on the response header before the body is read.
 */
const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "text/plain",
  "application/rss+xml",
  "application/atom+xml",
];

export function isAllowedContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_CONTENT_TYPES.includes(essence);
}

// --- address classification --------------------------------------------------

/** Dotted-quad only; anything else is not an IPv4 literal. */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const parsed = Number(part);
    if (parsed > 255) return null;
    octets.push(parsed);
  }
  return octets;
}

/**
 * Is this address one we must never talk to?
 *
 * Covers loopback, RFC1918, link-local (including the cloud metadata address
 * that lives inside it), CGNAT, multicast, reserved and broadcast space, plus
 * the IPv6 equivalents and IPv4-mapped IPv6 — which is the form that most often
 * slips through a check written only for dotted quads.
 */
export function isPrivateAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!value) return true;

  const v4 = parseIpv4(value);
  if (v4) {
    const [a = 0, b = 0] = v4;
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }

  // IPv6 (or something that is not an address at all — treated as unsafe).
  if (!value.includes(":")) return true;
  if (value === "::" || value === "::1") return true;
  // IPv4-mapped and IPv4-compatible: classify by the embedded v4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  if (value.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(value)) return true; // unique local
  if (value.startsWith("ff")) return true; // multicast
  if (value.startsWith("2001:db8")) return true; // documentation
  if (value.startsWith("64:ff9b")) return true; // NAT64 — reaches v4 space
  return false;
}

/** Does this hostname look like a bare IP address rather than a name? */
export function isIpLiteral(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "");
  return parseIpv4(value) !== null || value.includes(":");
}

/** Lowercased, trailing dot removed, punycode preserved. */
export function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/** Is `host` the configured domain, or a subdomain of it when allowed? */
export function hostInScope(
  host: string,
  registrableDomain: string,
  includeSubdomains: boolean,
): boolean {
  const target = normalizeHost(host);
  const root = normalizeHost(registrableDomain);
  if (!target || !root) return false;
  if (target === root) return true;
  // `www` is the one subdomain treated as the site itself: a crawl of
  // example.com that refused www.example.com would refuse most homepages.
  if (target === `www.${root}`) return true;
  return includeSubdomains && target.endsWith(`.${root}`);
}

// --- URL validation ----------------------------------------------------------

interface UrlCheck {
  ok: boolean;
  url?: URL;
  blocked?: BlockReason;
  reason?: string;
}

/**
 * Static checks: everything decidable from the URL alone, before any network.
 *
 * Runs on the seed URL and again on every redirect target, because a redirect
 * is just another URL supplied by someone else.
 */
export function checkUrl(raw: string, policy: CrawlScope): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, blocked: "invalid_host", reason: "unparseable url" };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      blocked: "scheme_not_allowed",
      reason: `scheme ${url.protocol} is not http or https`,
    };
  }
  // Credentials in a URL are how an allow-list gets talked past
  // (`https://target@evil.example`), and we never authenticate anyway.
  if (url.username || url.password) {
    return {
      ok: false,
      blocked: "credentials_in_url",
      reason: "url carries credentials",
    };
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return {
      ok: false,
      blocked: "port_not_allowed",
      reason: `port ${url.port} is not 80 or 443`,
    };
  }
  const host = normalizeHost(url.hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, blocked: "invalid_host", reason: "loopback name" };
  }
  // An IP literal can never be in scope: the crawl targets a configured DOMAIN,
  // and an address bypasses the name check entirely.
  if (isIpLiteral(host)) {
    return {
      ok: false,
      blocked: "ip_literal_host",
      reason: "ip address as target",
    };
  }
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
    return { ok: false, blocked: "invalid_host", reason: "malformed hostname" };
  }
  if (!hostInScope(host, policy.registrableDomain, policy.includeSubdomains)) {
    return {
      ok: false,
      blocked: "host_out_of_scope",
      reason: `${host} is outside the configured domain`,
    };
  }
  return { ok: true, url };
}

// --- DNS ---------------------------------------------------------------------

interface DohAnswer {
  data?: unknown;
  type?: unknown;
}

/**
 * Resolve a hostname over DNS-over-HTTPS.
 *
 * Workers has no DNS API, and the platform resolving the name for us inside
 * `fetch` is exactly what we must not rely on — we need the addresses *before*
 * the request so we can refuse them. A failed resolution is a refusal, not a
 * pass: failing open here would defeat the whole check.
 */
export async function resolveHost(
  hostname: string,
  fetchImpl: typeof fetch,
  timeoutMs = 4000,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const addresses: string[] = [];
    for (const type of ["A", "AAAA"]) {
      const response = await fetchImpl(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        {
          headers: { accept: "application/dns-json" },
          signal: controller.signal,
        },
      );
      if (!response.ok) continue;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) continue;
      const answers: unknown = (body as { Answer?: unknown }).Answer;
      if (!Array.isArray(answers)) continue;
      for (const answer of answers as unknown[]) {
        if (typeof answer !== "object" || answer === null) continue;
        const record = answer as DohAnswer;
        // Types 1 (A) and 28 (AAAA) only: a CNAME's data is a name, not an
        // address, and treating it as one would classify it as "not private".
        if (record.type !== 1 && record.type !== 28) continue;
        if (typeof record.data === "string") addresses.push(record.data);
      }
    }
    return addresses;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
