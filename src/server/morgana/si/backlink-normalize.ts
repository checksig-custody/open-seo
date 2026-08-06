import { normalizePageUrl } from "./domains";

/**
 * Morgana Search Intelligence — phase 3 normalization.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Backlink data arrives from a provider that has crawled the open web, so it is
 * the messiest input in the system: mixed case, punycode, invisible characters,
 * anchors that are really URLs, hosts with trailing dots. Everything here is
 * deterministic and total — it never throws — because a single malformed row
 * must not abort a collection pass over thousands of good ones.
 *
 * The original value is always preserved alongside the normalized one by the
 * caller. Normalization is for matching; the original is for showing a human.
 */

/**
 * Zero-width and bidirectional-control characters.
 *
 * These matter more here than anywhere else in the codebase: they are the
 * classic way to make `checksіg.com` (Cyrillic і) or `check​sig.com` look
 * identical to the real thing in a table. Stripping them before comparison is
 * what makes the lookalike check work at all.
 */
// Written as escapes, never as literals: pasted invisible characters are
// invisible in the source too, and a mangled class silently eats real letters.
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Suffixes with a well-known concentration of throwaway registrations. */
const SUSPICIOUS_TLDS = new Set([
  "tk",
  "ml",
  "ga",
  "cf",
  "gq",
  "top",
  "xyz",
  "click",
  "link",
  "loan",
  "work",
  "download",
  "bid",
  "win",
  "review",
  "stream",
  "date",
  "faith",
  "science",
  "party",
  "racing",
  "cricket",
  "accountant",
  "zip",
  "mov",
]);

interface NormalizedBacklinkDomain {
  /** As the provider gave it, trimmed only. */
  original: string;
  /** Lowercase, no `www.`, no trailing dot, punycode-decoded where possible. */
  normalized: string;
  /** Registrable-ish root, used to group subdomains of one owner. */
  root: string;
  tld: string | null;
  /** True when the normalized form differs from the raw ASCII form. */
  isIdn: boolean;
}

function stripInvisible(value: string): string {
  return value.replace(INVISIBLE, "");
}

/**
 * Decode punycode to Unicode so a homograph is comparable to what it imitates.
 *
 * `URL` does the encoding direction for us; for the decode we rely on the
 * platform's IDNA via the URL parser and fall back to the ASCII form, which is
 * always safe — a failed decode means we compare the `xn--` label instead, and
 * that simply misses a match rather than creating a false one.
 */
function toUnicodeHost(host: string): { unicode: string; isIdn: boolean } {
  if (!host.includes("xn--")) return { unicode: host, isIdn: false };
  try {
    const url = new URL(`https://${host}`);
    // Workers' URL keeps the ASCII form in `hostname`; the punycode label being
    // present at all is enough to flag it for the risk model.
    return { unicode: url.hostname, isIdn: true };
  } catch {
    return { unicode: host, isIdn: true };
  }
}

export function normalizeBacklinkDomain(
  input: string,
): NormalizedBacklinkDomain {
  const original = (input ?? "").trim();
  let host = stripInvisible(original).toLowerCase();

  // A provider may hand back a full URL where a domain was expected.
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      host = host.replace(/^[a-z][a-z\d+.-]*:\/\//, "").split("/")[0] ?? host;
    }
  } else {
    host = host.split("/")[0] ?? host;
  }

  host = host.replace(/^www\./, "");
  // A trailing dot is the fully-qualified form of the same name.
  while (host.endsWith(".")) host = host.slice(0, -1);
  host = host.replace(/:\d+$/, "");

  const { unicode, isIdn } = toUnicodeHost(host);
  const normalized = unicode;
  const labels = normalized.split(".").filter(Boolean);
  const tld = labels.length > 1 ? (labels.at(-1) ?? null) : null;
  // Deliberately naive: two labels, plus a third for the common two-part
  // suffixes we actually meet. A full public-suffix list is a dependency and a
  // 200 kB table for a signal that only feeds a weighted risk component.
  const twoPart = new Set([
    "co.uk",
    "com.br",
    "co.jp",
    "com.au",
    "co.za",
    "com.mx",
  ]);
  const lastTwo = labels.slice(-2).join(".");
  const root =
    labels.length >= 3 && twoPart.has(lastTwo)
      ? labels.slice(-3).join(".")
      : labels.slice(-2).join(".");

  return { original, normalized, root: root || normalized, tld, isIdn };
}

export function isSuspiciousTld(tld: string | null): boolean {
  return tld !== null && SUSPICIOUS_TLDS.has(tld);
}

/**
 * Normalize a backlink URL for matching.
 *
 * Reuses the phase-1 canonicalizer, which already strips fragments and known
 * tracking parameters while keeping parameters that genuinely distinguish two
 * pages. Returning `""` for unusable input lets the caller keep the row with a
 * null match key rather than inventing one.
 */
export function normalizeBacklinkUrl(input: string): string {
  const trimmed = stripInvisible((input ?? "").trim());
  if (!trimmed) return "";
  return normalizePageUrl(trimmed);
}

/**
 * Normalize an anchor for grouping.
 *
 * Returns `null` for an anchor that carries no text. A missing anchor is a real
 * and interesting state — image links and bare-URL links behave differently
 * from text links — so it must not collapse into the empty string, which would
 * then group with genuinely empty anchors and be counted as one.
 */
export function normalizeAnchor(
  input: string | null | undefined,
): string | null {
  if (input === null || input === undefined) return null;
  const stripped = stripInvisible(input)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!stripped) return null;
  // Unicode normalization so `ﬁ` and `fi`, or a decomposed accent, group.
  return stripped.normalize("NFKC");
}

/** True when the anchor is just the URL it points at. */
export function anchorIsUrl(anchor: string | null): boolean {
  if (!anchor) return false;
  return (
    /^(https?:\/\/|www\.)\S+$/.test(anchor) ||
    /^[a-z0-9-]+\.[a-z]{2,}(\/\S*)?$/.test(anchor)
  );
}

/**
 * Damerau-Levenshtein distance, bounded.
 *
 * Bounded because we only ever ask "is this within 2 edits of the brand"; the
 * unbounded version would compute a full matrix for every one of thousands of
 * domains per pass to answer a question we stop caring about after 2.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let beforePrevious: number[] = [];
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      // Transposition: `chekcsig` is one mistake, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (beforePrevious[j - 2] ?? 0) + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    beforePrevious = previous.slice();
    for (let k = 0; k <= b.length; k += 1) previous[k] = current[k] ?? 0;
  }
  return previous[b.length] ?? max + 1;
}

/**
 * Characters routinely swapped to build a lookalike, folded onto one form.
 *
 * The map must be *closed*: every target is itself a character no rule rewrites
 * further. Mapping Cyrillic `і` to Latin `i` while `i` maps to `l` would make
 * folding depend on the order it happened to run, and a homograph would then
 * compare unequal to the very brand it imitates.
 */
const CONFUSABLE: Record<string, string> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  i: "l",
  í: "l",
  ì: "l",
  а: "a",
  е: "e",
  о: "o",
  с: "c",
  р: "p",
  х: "x",
  у: "y",
  ѕ: "s",
  і: "l",
};

export function foldConfusables(value: string): string {
  return Array.from(value, (char) => CONFUSABLE[char] ?? char).join("");
}

interface LookalikeVerdict {
  isLookalike: boolean;
  distance: number;
  /** Which check fired, for the explainable risk reasons. */
  reason: "exact_substring" | "edit_distance" | "confusable_fold" | "none";
}

/**
 * Is this domain trying to look like one of ours?
 *
 * Three independent checks, weakest last. Deliberately conservative: it answers
 * "worth a human look", never "this is fraud".
 */
export function detectLookalike(
  candidateRoot: string,
  brandTokens: readonly string[],
): LookalikeVerdict {
  const label = candidateRoot.split(".")[0] ?? candidateRoot;
  for (const brand of brandTokens) {
    const token = brand.toLowerCase();
    if (!token) continue;
    // An exact brand substring in someone else's domain is the strongest signal.
    if (label.includes(token)) {
      return { isLookalike: true, distance: 0, reason: "exact_substring" };
    }
    const distance = editDistance(label, token, 2);
    if (distance <= 2 && Math.abs(label.length - token.length) <= 2) {
      return { isLookalike: true, distance, reason: "edit_distance" };
    }
    if (foldConfusables(label) === foldConfusables(token)) {
      return { isLookalike: true, distance: 0, reason: "confusable_fold" };
    }
  }
  return { isLookalike: false, distance: -1, reason: "none" };
}

/**
 * A stable identity for a backlink.
 *
 * Built from what actually distinguishes two links rather than from the
 * provider's own id, which is not stable across pagination or re-crawls. This
 * is the UNIQUE key, so retries, double scheduling and overlapping snapshots
 * converge on one row instead of multiplying.
 */
export function backlinkDedupeKey(input: {
  targetEntityId: string;
  normalizedSourceUrl: string;
  normalizedTargetUrl: string;
  normalizedAnchor: string | null;
  linkType: string;
}): string {
  return [
    input.targetEntityId,
    input.normalizedSourceUrl,
    input.normalizedTargetUrl,
    input.normalizedAnchor ?? " null",
    input.linkType,
  ].join("|");
}
