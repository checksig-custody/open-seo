import { describe, expect, it } from "vitest";
import {
  checkUrl,
  hostInScope,
  isIpLiteral,
  isPrivateAddress,
} from "./safe-fetch";
import {
  canonicalizeUrl,
  detectTrap,
  FrontierGuard,
  hasBlockedExtension,
  pathKey,
} from "./crawl-frontier";
import {
  hammingDistance,
  parseHtml,
  parseRobots,
  parseSitemap,
  robotsAllows,
} from "./site-audit-parse";

/**
 * Morgana Search Intelligence — phase 5 crawler safety tests.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P10).
 *
 * These cover the boundary, not the feature: what the crawler refuses, what it
 * refuses to keep refusing after a redirect, and what it will not turn into an
 * infinite queue. A regression in any of them is an SSRF or a runaway crawl,
 * which is why they are the tests that exist rather than a broad suite.
 */

const POLICY = { registrableDomain: "checksig.com", includeSubdomains: false };

/** Two pages differing only in a trailing word — the near-duplicate fixture. */
const nearDuplicateBody = (extra: string) =>
  `<html><body><p>Custodia istituzionale di bitcoin per aziende e investitori professionali con segregazione degli asset, verifica indipendente delle riserve, reportistica periodica e assicurazione dedicata sui saldi custoditi. ${extra}</p></body></html>`;

describe("private address classification", () => {
  it("blocks loopback, RFC1918, link-local and CGNAT", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "104.18.32.7", "172.32.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("blocks IPv6 loopback, unique-local, link-local and IPv4-mapped private", () => {
    for (const address of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("treats an unparseable address as unsafe", () => {
    expect(isPrivateAddress("not-an-address")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("url admission", () => {
  it("refuses non-http schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://checksig.com/x",
      "gopher://checksig.com",
      "data:text/html,<h1>x",
    ]) {
      expect(checkUrl(url, POLICY).ok, url).toBe(false);
    }
  });

  it("refuses credentials in the url", () => {
    const result = checkUrl("https://user:pass@checksig.com/", POLICY);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe("credentials_in_url");
  });

  it("refuses non-standard ports", () => {
    expect(checkUrl("https://checksig.com:8080/", POLICY).blocked).toBe(
      "port_not_allowed",
    );
    expect(checkUrl("http://checksig.com:80/", POLICY).ok).toBe(true);
  });

  it("refuses an IP literal even when it would resolve publicly", () => {
    expect(checkUrl("http://127.0.0.1/", POLICY).blocked).toBe(
      "ip_literal_host",
    );
    expect(checkUrl("http://8.8.8.8/", POLICY).blocked).toBe("ip_literal_host");
    expect(checkUrl("http://[::1]/", POLICY).blocked).toBe("ip_literal_host");
    expect(isIpLiteral("192.168.0.1")).toBe(true);
    expect(isIpLiteral("checksig.com")).toBe(false);
  });

  it("refuses localhost by name", () => {
    expect(checkUrl("http://localhost/", POLICY).ok).toBe(false);
    expect(checkUrl("http://api.localhost/", POLICY).ok).toBe(false);
  });

  it("confines the crawl to the configured domain", () => {
    expect(checkUrl("https://checksig.com/a", POLICY).ok).toBe(true);
    expect(checkUrl("https://www.checksig.com/a", POLICY).ok).toBe(true);
    expect(checkUrl("https://evil.example/a", POLICY).blocked).toBe(
      "host_out_of_scope",
    );
    // A subdomain is out of scope unless the entity opts in.
    expect(checkUrl("https://blog.checksig.com/a", POLICY).blocked).toBe(
      "host_out_of_scope",
    );
    expect(
      checkUrl("https://blog.checksig.com/a", {
        ...POLICY,
        includeSubdomains: true,
      }).ok,
    ).toBe(true);
  });

  it("does not treat a suffix match as a subdomain", () => {
    // notchecksig.com ends with "checksig.com" as a string but is a different
    // registrable domain: the dot is what makes the check correct.
    expect(hostInScope("notchecksig.com", "checksig.com", true)).toBe(false);
    expect(hostInScope("a.checksig.com", "checksig.com", true)).toBe(true);
  });
});

describe("canonicalization", () => {
  it("collapses the spellings of one page onto one key", () => {
    const expected = "https://checksig.com/servizi";
    for (const variant of [
      "https://checksig.com/servizi",
      "https://checksig.com/servizi/",
      "https://CheckSig.com/servizi#sezione",
      "https://checksig.com:443/servizi",
      "https://checksig.com//servizi",
      "https://checksig.com/servizi?utm_source=newsletter&utm_medium=email",
      "https://checksig.com/servizi?gclid=abc&fbclid=def",
      "https://checksig.com/servizi?sessionid=9182",
    ]) {
      expect(canonicalizeUrl(variant), variant).toBe(expected);
    }
  });

  it("sorts remaining parameters so order cannot mint a second URL", () => {
    expect(canonicalizeUrl("https://checksig.com/a?b=2&a=1")).toBe(
      canonicalizeUrl("https://checksig.com/a?a=1&b=2"),
    );
  });

  it("keeps functional parameters", () => {
    expect(canonicalizeUrl("https://checksig.com/a?id=42")).toContain("id=42");
  });

  it("resolves relative links against the page", () => {
    expect(canonicalizeUrl("../altro", "https://checksig.com/a/b")).toBe(
      "https://checksig.com/altro",
    );
  });

  it("groups query variants under one path key", () => {
    expect(pathKey("https://checksig.com/a?x=1")).toBe(
      "https://checksig.com/a",
    );
  });
});

describe("crawl traps", () => {
  it("refuses calendars, filter combinations and deep pagination", () => {
    expect(
      detectTrap("https://checksig.com/eventi?date=2026-08-06").trapped,
    ).toBe(true);
    expect(
      detectTrap("https://checksig.com/prodotti?filter=a&sort=price").trapped,
    ).toBe(true);
    expect(detectTrap("https://checksig.com/blog?page=99").trapped).toBe(true);
    expect(detectTrap("https://checksig.com/blog?page=2").trapped).toBe(false);
  });

  it("refuses an unbounded query-parameter combination", () => {
    expect(
      detectTrap("https://checksig.com/a?a=1&b=2&c=3&d=4&e=5").trapped,
    ).toBe(true);
  });

  it("refuses repeating path segments", () => {
    expect(detectTrap("https://checksig.com/a/b/a/b/a/b/a").trapped).toBe(true);
  });

  it("skips non-html resources", () => {
    expect(hasBlockedExtension("/brochure.pdf")).toBe(true);
    expect(hasBlockedExtension("/logo.PNG")).toBe(true);
    expect(hasBlockedExtension("/servizi")).toBe(false);
  });
});

describe("frontier admission", () => {
  const guard = () =>
    new FrontierGuard(
      { maxPages: 5, maxDepth: 2, maxVariantsPerPath: 2 },
      POLICY,
    );

  it("accepts an in-scope page once", () => {
    const frontier = guard();
    expect(frontier.consider("https://checksig.com/a", 1).accepted).toBe(true);
    const second = frontier.consider("https://checksig.com/a/", 1);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("already queued");
  });

  it("refuses external links", () => {
    expect(guard().consider("https://evil.example/a", 1).reason).toBe(
      "external link",
    );
  });

  it("enforces depth, page limit and variants per path", () => {
    const frontier = guard();
    expect(frontier.consider("https://checksig.com/deep", 3).reason).toBe(
      "max depth reached",
    );
    expect(frontier.consider("https://checksig.com/p?a=1", 1).accepted).toBe(
      true,
    );
    expect(frontier.consider("https://checksig.com/p?a=2", 1).accepted).toBe(
      true,
    );
    const third = frontier.consider("https://checksig.com/p?a=3", 1);
    expect(third.accepted).toBe(false);
    expect(third.reason).toBe("too many query variants of one path");

    const full = new FrontierGuard(
      { maxPages: 1, maxDepth: 5, maxVariantsPerPath: 5 },
      POLICY,
    );
    expect(full.consider("https://checksig.com/one", 1).accepted).toBe(true);
    expect(full.consider("https://checksig.com/two", 1).reason).toBe(
      "page limit reached",
    );
  });
});

describe("robots and sitemap", () => {
  it("prefers a group naming our agent over the wildcard group", () => {
    const rules = parseRobots(
      [
        "User-agent: *",
        "Disallow: /",
        "",
        "User-agent: Morgana-Site-Audit",
        "Disallow: /privato",
        "Sitemap: https://checksig.com/sitemap.xml",
      ].join("\n"),
    );
    expect(rules.disallow).toEqual(["/privato"]);
    expect(rules.sitemaps).toEqual(["https://checksig.com/sitemap.xml"]);
    expect(robotsAllows(rules, "/pubblico")).toBe(true);
    expect(robotsAllows(rules, "/privato/x")).toBe(false);
  });

  it("lets a longer Allow override a Disallow", () => {
    const rules = parseRobots(
      ["User-agent: *", "Disallow: /area", "Allow: /area/pubblica"].join("\n"),
    );
    expect(robotsAllows(rules, "/area/riservata")).toBe(false);
    expect(robotsAllows(rules, "/area/pubblica/x")).toBe(true);
  });

  it("reads a sitemap and a sitemap index differently", () => {
    const urlset = parseSitemap(
      `<urlset><url><loc>https://checksig.com/a</loc></url></urlset>`,
    );
    expect(urlset.valid).toBe(true);
    expect(urlset.urls).toEqual(["https://checksig.com/a"]);

    const index = parseSitemap(
      `<sitemapindex><sitemap><loc>https://checksig.com/s1.xml</loc></sitemap></sitemapindex>`,
    );
    expect(index.sitemaps).toEqual(["https://checksig.com/s1.xml"]);
    expect(index.urls).toEqual([]);

    expect(parseSitemap("<html></html>").valid).toBe(false);
  });
});

describe("html extraction", () => {
  it("reads the facts an audit needs and ignores script content", () => {
    const parsed = parseHtml(`
      <html><head>
        <title>CheckSig — custodia bitcoin</title>
        <meta name="description" content="Custodia istituzionale">
        <meta name="robots" content="noindex, follow">
        <link rel="canonical" href="https://checksig.com/">
      </head><body>
        <h1>Custodia</h1><h1>Secondo</h1>
        <script>var x = "<a href='/trappola'>no</a>";</script>
        <a href="/servizi">Servizi</a>
        <a href="mailto:info@checksig.com">Mail</a>
        <img src="/a.png" alt="ok"><img src="/b.png">
        <p>Testo visibile della pagina.</p>
      </body></html>`);
    expect(parsed.title).toBe("CheckSig — custodia bitcoin");
    expect(parsed.metaDescription).toBe("Custodia istituzionale");
    expect(parsed.robotsDirective).toBe("noindex, follow");
    expect(parsed.canonical).toBe("https://checksig.com/");
    expect(parsed.h1s).toHaveLength(2);
    // The link inside <script> must not become a crawl candidate, and mailto:
    // is not a page.
    expect(parsed.links.map((link) => link.href)).toEqual(["/servizi"]);
    expect(parsed.imageCount).toBe(2);
    expect(parsed.imagesMissingAlt).toBe(1);
    expect(parsed.textLength).toBeGreaterThan(0);
  });

  it("fingerprints near-identical pages close together and different ones far apart", () => {
    // The promise is a SMALL DISTANCE, not equality: the fingerprint is a
    // SimHash, and asserting equality here is what hid the previous version's
    // real defect (a fingerprint too brittle for the check to ever fire).
    const a = parseHtml(nearDuplicateBody("Aggiornato marted&igrave;"));
    const b = parseHtml(nearDuplicateBody("Aggiornato mercoled&igrave;"));
    // 5 bits is the threshold `checkSite` uses; unrelated pages sit above 12.
    expect(hammingDistance(a.contentHash, b.contentHash)).toBeLessThanOrEqual(
      5,
    );

    const different = parseHtml(
      "<html><body><p>Ricette tradizionali liguri con basilico genovese, pinoli tostati, formaggio stagionato e olio extravergine prodotto localmente dalle colline vicine al mare.</p></body></html>",
    );
    expect(
      hammingDistance(a.contentHash, different.contentHash),
    ).toBeGreaterThan(5);
  });
});
