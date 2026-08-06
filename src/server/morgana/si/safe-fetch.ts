import {
  checkUrl,
  isAllowedContentType,
  isPrivateAddress,
  resolveHost,
  type BlockReason,
  type DnsResolver,
} from "./net-guard";

export * from "./net-guard";

/**
 * Morgana Search Intelligence — the crawler's fetch boundary.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * This is the only place in the engine that fetches a URL that came from
 * outside, so it is the only place an SSRF can start. `net-guard.ts` holds the
 * admission rules; this file holds the one property that needs the transport to
 * state: **a request leaves only for a public address on a host we were
 * configured to crawl, and that stays true after every redirect.**
 *
 * Redirects are followed by hand (`redirect: "manual"`). That is not an
 * optimisation — letting the platform follow a hop we never validated is the
 * whole attack.
 */

export interface FetchPolicy {
  /** Registrable domain the crawl is confined to, normalized and lowercased. */
  registrableDomain: string;
  /** Subdomains are in scope only when the entity says so. */
  includeSubdomains: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Injectable for tests. Defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to DNS-over-HTTPS against Cloudflare. */
  resolver?: DnsResolver;
}

export interface SafeFetchResult {
  ok: boolean;
  /** Present when the request completed, whatever the status code. */
  status?: number;
  contentType?: string | null;
  body?: string;
  bytes: number;
  responseTimeMs: number;
  /** Every hop, in order. A redirect chain is evidence, not noise. */
  redirectChain: string[];
  finalUrl?: string;
  blocked?: BlockReason;
  reason?: string;
}

export const DEFAULT_USER_AGENT = "Morgana-Site-Audit/1.0";
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;

// --- the fetch itself --------------------------------------------------------

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      // Stop reading rather than buffering the rest: the cap exists to bound
      // memory, so honouring it after the fact would be pointless.
      await reader.cancel().catch(() => undefined);
      return { text, bytes, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, bytes, truncated: false };
}

/**
 * Fetch one URL under the crawl policy, following redirects by hand.
 *
 * `redirect: "manual"` is not an optimisation: automatic following would let
 * the platform take a hop we never validated, which is the whole attack.
 */
export async function safeFetch(
  rawUrl: string,
  policy: FetchPolicy,
): Promise<SafeFetchResult> {
  const fetchImpl = policy.fetchImpl ?? fetch;
  const resolver: DnsResolver =
    policy.resolver ?? ((hostname) => resolveHost(hostname, fetchImpl));
  const maxRedirects = policy.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = policy.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = policy.maxBytes ?? MAX_BYTES;
  const started = Date.now();
  const redirectChain: string[] = [];

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = checkUrl(current, policy);
    if (!check.ok || !check.url) {
      return {
        ok: false,
        bytes: 0,
        responseTimeMs: Date.now() - started,
        redirectChain,
        blocked: check.blocked ?? "invalid_host",
        reason: check.reason,
      };
    }

    // Rule 2: resolve on EVERY hop. A first-hop-only check is a rebinding hole.
    const addresses = await resolver(check.url.hostname);
    if (addresses.length === 0) {
      return {
        ok: false,
        bytes: 0,
        responseTimeMs: Date.now() - started,
        redirectChain,
        blocked: "dns_unresolved",
        reason: `could not resolve ${check.url.hostname}`,
      };
    }
    // ALL answers must be public. One private address in the set is enough to
    // refuse: we cannot control which one the platform will connect to.
    const privateAddress = addresses.find((address) =>
      isPrivateAddress(address),
    );
    if (privateAddress !== undefined) {
      return {
        ok: false,
        bytes: 0,
        responseTimeMs: Date.now() - started,
        redirectChain,
        blocked: "private_address",
        reason: `${check.url.hostname} resolves to a private address`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(check.url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Identifiable on purpose: a site owner who wants to block us must be
          // able to. No cookies, no Authorization, no session of any kind.
          "user-agent": policy.userAgent ?? DEFAULT_USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
          "accept-language": "it,en;q=0.8",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return {
            ok: true,
            status: response.status,
            contentType: response.headers.get("content-type"),
            bytes: 0,
            responseTimeMs: Date.now() - started,
            redirectChain,
            finalUrl: check.url.toString(),
          };
        }
        redirectChain.push(check.url.toString());
        if (hop === maxRedirects) {
          return {
            ok: false,
            status: response.status,
            bytes: 0,
            responseTimeMs: Date.now() - started,
            redirectChain,
            blocked: "too_many_redirects",
            reason: `more than ${String(maxRedirects)} redirects`,
          };
        }
        current = new URL(location, check.url).toString();
        continue;
      }

      const contentType = response.headers.get("content-type");
      // Checked before the body is touched, and again against the declared
      // length, so an oversized or binary response costs one header read.
      const declaredLength = Number(
        response.headers.get("content-length") ?? "0",
      );
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        return {
          ok: false,
          status: response.status,
          contentType,
          bytes: declaredLength,
          responseTimeMs: Date.now() - started,
          redirectChain,
          blocked: "response_too_large",
          reason: `declared ${String(declaredLength)} bytes`,
        };
      }
      if (response.status < 400 && !isAllowedContentType(contentType)) {
        return {
          ok: false,
          status: response.status,
          contentType,
          bytes: 0,
          responseTimeMs: Date.now() - started,
          redirectChain,
          finalUrl: check.url.toString(),
          blocked: "content_type_not_allowed",
          reason: contentType ?? "missing content-type",
        };
      }

      const { text, bytes, truncated } = await readBounded(response, maxBytes);
      if (truncated) {
        return {
          ok: false,
          status: response.status,
          contentType,
          bytes,
          responseTimeMs: Date.now() - started,
          redirectChain,
          finalUrl: check.url.toString(),
          blocked: "response_too_large",
          reason: `body exceeded ${String(maxBytes)} bytes`,
        };
      }

      return {
        ok: true,
        status: response.status,
        contentType,
        body: text,
        bytes,
        responseTimeMs: Date.now() - started,
        redirectChain,
        finalUrl: check.url.toString(),
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        bytes: 0,
        responseTimeMs: Date.now() - started,
        redirectChain,
        blocked: aborted ? "timeout" : "network_error",
        reason: aborted
          ? `timed out after ${String(timeoutMs)}ms`
          : "fetch failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    bytes: 0,
    responseTimeMs: Date.now() - started,
    redirectChain,
    blocked: "too_many_redirects",
    reason: "redirect budget exhausted",
  };
}
