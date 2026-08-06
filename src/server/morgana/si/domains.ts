import { normalizeDomainInput } from "@/server/lib/domainUtils";
import { isValidDomainHost } from "@/types/schemas/domain";

/**
 * Morgana Search Intelligence — strict domain input validation.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Upstream's `normalizeDomainInput` is permissive by design: it accepts any
 * `scheme://` prefix and silently drops URL credentials, because it is fed by a
 * product form where being forgiving is a feature. Search Intelligence accepts
 * domains from an admin API, so it must REJECT what upstream forgives rather
 * than quietly normalise it away — a caller who typed `user:pass@host` or
 * `file://` has made an error worth surfacing, and silently accepting it is how
 * an SSRF-shaped input becomes a stored configuration.
 *
 * This wraps upstream rather than replacing it, so the tldts-backed
 * registrable-domain and fake-TLD logic stays in one place.
 */

export class DomainValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DomainValidationError";
  }
}

interface NormalizedDomain {
  /** What the operator typed, trimmed. Shown in the UI. */
  display: string;
  /** Lowercased, ASCII/punycode, no protocol, no www, no path. The match key. */
  normalized: string;
  /**
   * True when the normalised host contains a punycode (`xn--`) label.
   *
   * The stored and displayed value stays ASCII punycode on purpose. Rendering
   * the Unicode form is exactly what makes a homograph attack work — `аpple.com`
   * with a Cyrillic а is indistinguishable from `apple.com` — so the mitigation
   * is to show the punycode and flag it, not to prettify it.
   */
  isInternationalized: boolean;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Hosts that must never be reachable targets even if some registry made them
// resolvable. `isValidDomainHost` already rejects bare IPs and suffix-less
// names; this is the belt to that braces.
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".onion"];

/**
 * Validate and normalise a domain for use as a Search Intelligence entity.
 *
 * Rejects (§35): credentials in the URL, non-HTTP(S) schemes, IP literals,
 * loopback/private/link-local names, paths where a bare domain is required,
 * malformed hosts, and unregistrable suffixes.
 */
export function normalizeEntityDomain(
  input: string,
  options: { includeSubdomains?: boolean } = {},
): NormalizedDomain {
  const display = input.trim();
  if (!display) {
    throw new DomainValidationError("Domain is required", "domain_required");
  }
  if (display.length > 253) {
    throw new DomainValidationError("Domain is too long", "domain_too_long");
  }

  // Credentials must be refused before parsing: `new URL()` accepts them and
  // exposes only `hostname`, so a later check would never see them.
  if (
    /^[a-z][a-z\d+.-]*:\/\/[^/@]*@/i.test(display) ||
    /^[^/]*@/.test(display)
  ) {
    throw new DomainValidationError(
      "Domain must not contain credentials",
      "domain_has_credentials",
    );
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(display);
  if (hasScheme) {
    const scheme = /^([a-z][a-z\d+.-]*:)\/\//i
      .exec(display)?.[1]
      ?.toLowerCase();
    if (!scheme || !ALLOWED_PROTOCOLS.has(scheme)) {
      throw new DomainValidationError(
        "Only http and https are supported",
        "domain_bad_scheme",
      );
    }
  } else if (display.includes("/")) {
    // A bare domain with a path is ambiguous: the caller may have meant a page.
    // Refuse rather than guess which part is the domain.
    throw new DomainValidationError(
      "Enter a domain, not a URL path",
      "domain_has_path",
    );
  }

  // Upstream does protocol stripping, www removal, IP and fake-TLD rejection
  // and the registrable-domain reduction. Reuse it; do not reimplement.
  let normalized: string;
  try {
    normalized = normalizeDomainInput(
      display,
      options.includeSubdomains ?? false,
    );
  } catch (error) {
    throw new DomainValidationError(
      error instanceof Error && error.message
        ? error.message
        : "Domain is invalid",
      "domain_invalid",
    );
  }

  if (BLOCKED_HOSTS.has(normalized)) {
    throw new DomainValidationError(
      "Loopback hosts are not valid targets",
      "domain_loopback",
    );
  }
  if (BLOCKED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    throw new DomainValidationError(
      "Private and non-public suffixes are not valid targets",
      "domain_private_suffix",
    );
  }
  // Re-assert after normalisation: the reduction to a registrable domain can
  // in principle change what we are validating.
  if (!isValidDomainHost(normalized)) {
    throw new DomainValidationError(
      "Enter a valid domain like example.com",
      "domain_invalid",
    );
  }

  const isInternationalized = normalized
    .split(".")
    .some((label) => label.startsWith("xn--"));

  return { display, normalized, isInternationalized };
}

/**
 * Canonicalise a page URL for storage and comparison: strip the fragment,
 * lowercase the host, drop `www.`, remove tracking parameters and collapse a
 * trailing slash. The original is always stored alongside.
 */
const TRACKING_PARAMS = new Set([
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
  "ref",
  "referrer",
  "source",
]);

export function normalizePageUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    // Unparseable input is returned as-is rather than dropped: the caller
    // stores it next to the original, and losing the row would lose data.
    return trimmed.toLowerCase();
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return trimmed.toLowerCase();
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  // The root path collapses to nothing, not to "/". Leaving the slash would
  // make `example.com/` and `example.com` two different keys for one page.
  let path = parsed.pathname;
  while (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  const query = parsed.searchParams.toString();
  return `${parsed.hostname}${path}${query ? `?${query}` : ""}`;
}

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
