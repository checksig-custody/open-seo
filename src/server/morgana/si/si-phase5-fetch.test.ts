import { describe, expect, it, vi } from "vitest";
import { isAllowedContentType, safeFetch } from "./safe-fetch";

/**
 * Morgana Search Intelligence — the crawler's fetch boundary.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * These are the tests that matter most in phase 5: each one is an SSRF that
 * would work if the corresponding check were removed. The admission rules are
 * covered separately in `si-phase5-safety.test.ts`.
 */

const POLICY = { registrableDomain: "checksig.com", includeSubdomains: false };

/**
 * A fetch double plus a call counter.
 *
 * Typed once here so no test needs a cast, and the counter is returned
 * separately because "was a request made at all" is exactly what the two
 * refusal cases below have to assert.
 */
function stubFetch(respond: () => Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: { count: number };
} {
  const calls = { count: 0 };
  const fetchImpl: typeof fetch = () => {
    calls.count += 1;
    return respond();
  };
  return { fetchImpl, calls };
}

function htmlResponse(body: string, contentType = "text/html"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("safeFetch", () => {
  it("refuses to request a host that resolves to a private address", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Promise.resolve(htmlResponse("<html></html>")),
    );
    const result = await safeFetch("https://checksig.com/", {
      ...POLICY,
      fetchImpl,
      resolver: () => Promise.resolve(["10.0.0.5"]),
    });
    expect(result.blocked).toBe("private_address");
    // The point: no request was made at all.
    expect(calls.count).toBe(0);
  });

  it("refuses when DNS cannot be resolved rather than letting the platform try", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Promise.resolve(htmlResponse("<html></html>")),
    );
    const result = await safeFetch("https://checksig.com/", {
      ...POLICY,
      fetchImpl,
      resolver: () => Promise.resolve([]),
    });
    expect(result.blocked).toBe("dns_unresolved");
    expect(calls.count).toBe(0);
  });

  it("re-validates DNS after a redirect (rebinding)", async () => {
    // First hop resolves publicly; the redirect target resolves privately. A
    // check that only ran on the first URL would follow it.
    const resolver = vi
      .fn()
      .mockResolvedValueOnce(["104.18.32.7"])
      .mockResolvedValueOnce(["169.254.169.254"]);
    const { fetchImpl, calls } = stubFetch(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://www.checksig.com/next" },
        }),
      ),
    );
    const result = await safeFetch("https://checksig.com/", {
      ...POLICY,
      fetchImpl,
      resolver,
    });
    expect(result.blocked).toBe("private_address");
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(calls.count).toBe(1);
  });

  it("refuses a redirect that leaves the configured domain", async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: "https://evil.example/" },
        }),
      ),
    );
    const result = await safeFetch("https://checksig.com/", {
      ...POLICY,
      fetchImpl,
      resolver: () => Promise.resolve(["104.18.32.7"]),
    });
    expect(result.blocked).toBe("host_out_of_scope");
  });

  it("stops after five redirects", async () => {
    let hop = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      hop += 1;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://checksig.com/hop-${String(hop)}` },
        }),
      );
    });
    const result = await safeFetch("https://checksig.com/", {
      ...POLICY,
      fetchImpl,
      resolver: () => Promise.resolve(["104.18.32.7"]),
    });
    expect(result.blocked).toBe("too_many_redirects");
    expect(calls.count).toBe(6); // initial + 5 hops
  });

  it("refuses a body larger than the cap without buffering it", async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response("x".repeat(5000), {
          status: 200,
          headers: { "content-type": "text/html", "content-length": "5000" },
        }),
      ),
    );
    const result = await safeFetch("https://checksig.com/", {
      ...POLICY,
      maxBytes: 1000,
      fetchImpl,
      resolver: () => Promise.resolve(["104.18.32.7"]),
    });
    expect(result.blocked).toBe("response_too_large");
  });

  it("refuses a content type we do not read", async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(htmlResponse("%PDF-1.4", "application/pdf")),
    );
    const result = await safeFetch("https://checksig.com/doc", {
      ...POLICY,
      fetchImpl,
      resolver: () => Promise.resolve(["104.18.32.7"]),
    });
    expect(result.blocked).toBe("content_type_not_allowed");
    expect(isAllowedContentType("text/html; charset=utf-8")).toBe(true);
    expect(isAllowedContentType("image/png")).toBe(false);
    expect(isAllowedContentType(null)).toBe(false);
  });

  it("sends an identifiable agent and no credentials", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      seen = init;
      return Promise.resolve(htmlResponse("<html></html>"));
    };
    await safeFetch("https://checksig.com/", {
      ...POLICY,
      fetchImpl,
      resolver: () => Promise.resolve(["104.18.32.7"]),
    });
    const headers = new Headers(seen?.headers);
    expect(headers.get("user-agent")).toBe("Morgana-Site-Audit/1.0");
    // No credential of any kind travels with a crawl request.
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    // Manual redirects are a control, not a preference.
    expect(seen?.redirect).toBe("manual");
  });
});
