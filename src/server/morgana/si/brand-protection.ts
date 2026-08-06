/**
 * Morgana Search Intelligence — brand-protection signal adapter.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P8).
 *
 * Brand-protection data — mentions, Telegram, social, existing impersonation
 * findings — lives in **Morgana's** database, and the engine has no access to
 * it and must not acquire any: they are separate bounded contexts with separate
 * D1 instances, and that separation is the whole Phase-0 guarantee.
 *
 * So the signals travel the other way. Morgana looks them up and hands them to
 * the engine on the refresh call; the engine reads them from a request-scoped
 * registry and, when nothing was supplied, reports `no_known_signal`.
 *
 * `no_known_signal` is NOT `safe`. It means we did not look, or looked and found
 * nothing — which for a domain registered yesterday is exactly what you would
 * expect to see. Collapsing the two would turn absence of evidence into
 * evidence of absence in a security feature.
 */

export interface BrandProtectionCounts {
  mentionCount?: number;
  telegramMentionCount?: number;
  socialMentionCount?: number;
  negativeSentimentCount?: number;
  existingImpersonationFindings?: number;
}

export interface BrandProtectionSignals {
  domain: string;
  status: "no_known_signal" | "signals_present";
  hasSignals: boolean;
  counts: BrandProtectionCounts;
  /** Opaque Morgana references (mention ids) so the UI can deep-link. */
  references: string[];
}

/**
 * Request-scoped registry.
 *
 * Module-level state is safe here because a Workers isolate handles one request
 * at a time within a fetch, and every entry point clears it — but it is cleared
 * explicitly rather than relying on that, because a leaked map would attribute
 * one refresh's signals to the next.
 */
let registry = new Map<string, BrandProtectionSignals>();

function empty(domain: string): BrandProtectionSignals {
  return {
    domain,
    status: "no_known_signal",
    hasSignals: false,
    counts: {},
    references: [],
  };
}

/** Load the signals Morgana supplied with this request. */
export function setBrandProtectionSignals(
  input: readonly {
    domain: string;
    counts?: BrandProtectionCounts;
    references?: readonly string[];
  }[],
): void {
  registry = new Map(
    input.map((entry) => {
      const counts = entry.counts ?? {};
      const total = Object.values(counts).reduce<number>(
        (sum, value) => sum + (typeof value === "number" ? value : 0),
        0,
      );
      return [
        entry.domain,
        {
          domain: entry.domain,
          status: total > 0 ? "signals_present" : "no_known_signal",
          hasSignals: total > 0,
          counts,
          references: [...(entry.references ?? [])].slice(0, 20),
        },
      ];
    }),
  );
}

export function clearBrandProtectionSignals(): void {
  registry = new Map();
}

/**
 * Aggregated brand-protection signals for one domain.
 *
 * Async by design: today it reads a map, but the signature is the seam that
 * lets the lookup become a call without touching every caller.
 */
export function getBrandProtectionSignals(
  domain: string,
): Promise<BrandProtectionSignals> {
  return Promise.resolve(registry.get(domain) ?? empty(domain));
}
