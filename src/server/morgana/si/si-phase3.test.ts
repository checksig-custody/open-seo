import { describe, expect, it } from "vitest";
import {
  anchorIsUrl,
  backlinkDedupeKey,
  detectLookalike,
  editDistance,
  foldConfusables,
  isSuspiciousTld,
  normalizeAnchor,
  normalizeBacklinkDomain,
  normalizeBacklinkUrl,
} from "./backlink-normalize";
import { aggregateAnchors, classifyAnchor } from "./backlink-anchors";

const BRAND = ["checksig"] as const;

describe("domain normalization", () => {
  it("collapses the forms of one host to a single key", () => {
    const forms = [
      "Example.com",
      "www.example.com",
      "example.com.",
      "https://WWW.Example.com/path",
      "example.com:443",
    ];
    const keys = new Set(
      forms.map((form) => normalizeBacklinkDomain(form).normalized),
    );
    expect(keys).toEqual(new Set(["example.com"]));
  });

  it("strips invisible characters used to disguise a hostname", () => {
    // A zero-width space is the cheapest way to make a lookalike read as real.
    const result = normalizeBacklinkDomain("check​sig.com");
    expect(result.normalized).toBe("checksig.com");
  });

  it("keeps the original alongside the normalized form", () => {
    const result = normalizeBacklinkDomain("  WWW.Example.COM  ");
    expect(result.original).toBe("WWW.Example.COM");
    expect(result.normalized).toBe("example.com");
  });

  it("flags punycode rather than silently accepting it", () => {
    expect(normalizeBacklinkDomain("xn--chcksig-hya.com").isIdn).toBe(true);
    expect(normalizeBacklinkDomain("checksig.com").isIdn).toBe(false);
  });

  it("groups subdomains under one root but keeps two-part suffixes intact", () => {
    expect(normalizeBacklinkDomain("blog.news.example.com").root).toBe(
      "example.com",
    );
    expect(normalizeBacklinkDomain("blog.example.co.uk").root).toBe(
      "example.co.uk",
    );
  });

  it("never throws on malformed input", () => {
    for (const bad of ["", "   ", "://", "http://", "...", "a b c"]) {
      expect(() => normalizeBacklinkDomain(bad)).not.toThrow();
    }
  });

  it("recognises throwaway suffixes without treating every new tld as bad", () => {
    expect(isSuspiciousTld("tk")).toBe(true);
    expect(isSuspiciousTld("com")).toBe(false);
    expect(isSuspiciousTld(null)).toBe(false);
  });
});

describe("url normalization", () => {
  it("drops tracking parameters but keeps parameters that identify a page", () => {
    expect(
      normalizeBacklinkUrl("https://example.com/post?utm_source=x&id=42"),
    ).toBe("example.com/post?id=42");
  });

  it("treats the root path and the bare host as one page", () => {
    expect(normalizeBacklinkUrl("https://example.com/")).toBe(
      normalizeBacklinkUrl("https://example.com"),
    );
  });
});

describe("anchor normalization", () => {
  it("returns null for a missing anchor rather than an empty string", () => {
    // An image link has no anchor; that is a real state and must stay distinct
    // from an anchor whose text happens to be blank after trimming.
    expect(normalizeAnchor(null)).toBeNull();
    expect(normalizeAnchor("   ")).toBeNull();
    expect(normalizeAnchor("​")).toBeNull();
  });

  it("collapses whitespace and case so one anchor groups once", () => {
    expect(normalizeAnchor("  CheckSig   Custodia ")).toBe("checksig custodia");
  });

  it("recognises an anchor that is really a url", () => {
    expect(anchorIsUrl("https://example.com/a")).toBe(true);
    expect(anchorIsUrl("example.com")).toBe(true);
    expect(anchorIsUrl("custodia bitcoin")).toBe(false);
  });
});

describe("lookalike detection", () => {
  it("counts a transposition as one mistake, not two", () => {
    expect(editDistance("chekcsig", "checksig")).toBe(1);
  });

  it("bails out early instead of scoring unrelated strings", () => {
    expect(
      editDistance("checksig", "completely-different-domain", 2),
    ).toBeGreaterThan(2);
  });

  it("folds digits and cyrillic homographs onto the same form as the brand", () => {
    // The folded form is not the brand spelling — `i` folds to `l` too — but
    // both sides land on one string, which is all the comparison needs.
    expect(foldConfusables("check5ig")).toBe(foldConfusables("checksig"));
    expect(foldConfusables("сhecksig")).toBe(foldConfusables("checksig"));
  });

  it("catches the three families of impersonation", () => {
    expect(detectLookalike("checksig-support.com", BRAND).reason).toBe(
      "exact_substring",
    );
    expect(detectLookalike("chekcsig.com", BRAND).reason).toBe("edit_distance");
    // A homograph within the edit bound is caught by the cheaper check first;
    // what matters is that it is caught, not which rule fired.
    expect(detectLookalike("check5ig.com", BRAND).isLookalike).toBe(true);
    expect(detectLookalike("сhесksіg.com", BRAND).isLookalike).toBe(true);
  });

  it("does not flag an unrelated domain", () => {
    expect(detectLookalike("coindesk.com", BRAND).isLookalike).toBe(false);
    expect(detectLookalike("bitcoinmagazine.com", BRAND).isLookalike).toBe(
      false,
    );
  });
});

describe("backlink deduplication", () => {
  const base = {
    targetEntityId: "se_1",
    normalizedSourceUrl: "example.com/post",
    normalizedTargetUrl: "checksig.com/custodia",
    normalizedAnchor: "checksig",
    linkType: "anchor",
  };

  it("is stable across retries and pagination", () => {
    expect(backlinkDedupeKey(base)).toBe(backlinkDedupeKey({ ...base }));
  });

  it("separates two links that differ only by anchor", () => {
    expect(backlinkDedupeKey(base)).not.toBe(
      backlinkDedupeKey({ ...base, normalizedAnchor: "custodia" }),
    );
  });

  it("does not confuse a null anchor with a literal 'null' anchor", () => {
    expect(backlinkDedupeKey({ ...base, normalizedAnchor: null })).not.toBe(
      backlinkDedupeKey({ ...base, normalizedAnchor: "null" }),
    );
  });
});

describe("anchor classification", () => {
  const classify = (anchor: string | null, sourceRoot = "randomblog.com") =>
    classifyAnchor({
      anchor,
      brandTokens: BRAND,
      sourceRoot,
      officialRoots: ["checksig.com"],
      keywords: ["custodia bitcoin"],
    });

  it("separates the brand from a phrase containing it", () => {
    expect(classify("checksig", "checksig.com").category).toBe("brand");
    expect(classify("guida checksig 2026", "checksig.com").category).toBe(
      "brand_variant",
    );
  });

  it("classifies keywords, urls, generics and empties", () => {
    expect(classify("custodia bitcoin", "checksig.com").category).toBe(
      "exact_keyword",
    );
    expect(
      classify("la custodia bitcoin spiegata", "checksig.com").category,
    ).toBe("partial_keyword");
    expect(classify("https://checksig.com", "checksig.com").category).toBe(
      "url",
    );
    expect(classify("clicca qui", "checksig.com").category).toBe("generic");
    expect(classify(null).category).toBe("empty");
  });

  it("flags the brand combined with a credential term on a third-party domain", () => {
    const result = classify("checksig login");
    expect(result.category).toBe("suspicious");
    expect(result.suspiciousSignal).toContain("possible impersonation signal");
  });

  it("does not flag the same anchor coming from our own site", () => {
    expect(classify("checksig login", "checksig.com").category).not.toBe(
      "suspicious",
    );
  });

  it("phrases a finding as a signal, never as an accusation", () => {
    const signal = classify("checksig wallet recovery").suspiciousSignal ?? "";
    expect(signal).toMatch(/possible|signal/i);
    expect(signal).not.toMatch(/fraud|scam|malicious/i);
  });

  it("counts distinct referring domains, not just link volume", () => {
    // One domain linking 3× is weaker than 3 domains linking once, and the
    // aggregate has to keep those apart.
    const aggregates = aggregateAnchors(
      [
        {
          anchorText: "checksig",
          normalizedAnchor: "checksig",
          normalizedSourceDomain: "a.com",
        },
        {
          anchorText: "checksig",
          normalizedAnchor: "checksig",
          normalizedSourceDomain: "a.com",
        },
        {
          anchorText: "checksig",
          normalizedAnchor: "checksig",
          normalizedSourceDomain: "b.com",
        },
      ],
      (anchor, sourceRoot) => classify(anchor, sourceRoot),
    );
    expect(aggregates[0]?.backlinkCount).toBe(3);
    expect(aggregates[0]?.referringDomainCount).toBe(2);
  });
});
