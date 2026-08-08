/**
 * Morgana Search Intelligence — what a provider error says about the ACCOUNT.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P20).
 *
 * PURE ON PURPOSE, and split from `provider-circuit.ts` for the same reason
 * `provider-status.ts` was split from `service.ts`: a module that imports the
 * D1 client cannot be loaded outside the Workers runtime, so a decision living
 * beside one is a decision no unit test can reach. That is not a stylistic
 * point — an inverted condition in exactly that position survived every suite
 * in this repository until a real credential was provisioned.
 *
 * The classification below is the highest-stakes mapping in the subsystem: a
 * wrong `account_suspended` stops every collector, and a missed one keeps
 * billing a suspended account. It has no clock, no database and no network, so
 * it can be pinned exhaustively.
 */

/** The single provider this subsystem talks to. */
export const PROVIDER = "dataforseo";

export type ProviderCircuitState =
  | "healthy"
  | "account_suspended"
  | "auth_failed"
  | "account_not_enabled";

/** States that stop paid work until a human acts. */
const LATCHED: ReadonlySet<ProviderCircuitState> = new Set([
  "account_suspended",
  "auth_failed",
  "account_not_enabled",
]);

export function isLatched(state: ProviderCircuitState): boolean {
  return LATCHED.has(state);
}

/**
 * DataForSEO status codes this engine is willing to name.
 *
 * Deliberately short. `40201` is documented by the provider — and observed by
 * this project — as the account-suspension code; `40202` as rate limiting. The
 * authentication family is recognised by range because the provider uses
 * several codes for it, and the "not enabled" family likewise. Everything
 * outside these stays unclassified.
 */
export interface ProviderAccountEvent {
  /**
   * `healthy` is deliberately not in this union: this classifies a THROWN
   * error, and no error has ever meant the account is fine. Health is
   * established by `provider-health.ts` asking, never inferred from a failure.
   */
  kind: Exclude<ProviderCircuitState, "healthy"> | "rate_limited" | "none";
  statusCode: number | null;
  sanitizedMessage: string | null;
}

/**
 * Strip anything that could be a secret before a provider's words are stored.
 *
 * Provider error text echoes the request back in several endpoints, so it may
 * contain a login, a base64 Authorization header or a URL carrying either. The
 * message is worth keeping — it is what tells an operator WHY the account was
 * suspended — but only after everything credential-shaped is gone.
 */
export function sanitizeProviderMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stripped = value
    // URLs (which may carry credentials in userinfo or query).
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    // Anything that looks like a base64 credential blob.
    .replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, "[redacted]")
    // `login:password` pairs and bare email-shaped logins.
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[redacted]")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === "" ? null : stripped.slice(0, 300);
}

/**
 * Predicate, not an assertion.
 *
 * Everything reaching this file arrives as `unknown` from a `catch`, and the
 * narrowing has to be a check the compiler can see — an assertion here would be
 * this module promising a shape it was handed rather than one it verified,
 * which is the failure it exists to catch.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull the numeric DataForSEO status code out of a thrown error, if it has one. */
function statusCodeOf(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const details = error.details;
  if (isRecord(details)) {
    const parsed = Number(details.dataforseoStatusCode);
    if (Number.isInteger(parsed)) return parsed;
  }
  // Some upstream paths carry the code directly.
  const direct = error.statusCode;
  return typeof direct === "number" && Number.isInteger(direct) ? direct : null;
}

/**
 * What, if anything, did this error say about the ACCOUNT?
 *
 * Pure: no database, no clock, no network — so the mapping can be tested
 * exhaustively, which matters more here than anywhere else in the subsystem.
 * A wrong `account_suspended` stops the whole engine; a missed one bills a
 * suspended account until somebody notices.
 */
export function classifyProviderAccountEvent(
  error: unknown,
): ProviderAccountEvent {
  const statusCode = statusCodeOf(error);
  const sanitizedMessage = sanitizeProviderMessage(
    error instanceof Error ? error.message : null,
  );
  // Read as a string only when it IS one. `String(...)` on an arbitrary `code`
  // would stringify an object to "[object Object]" and then compare it, which
  // is a match that can never happen and a bug that never announces itself.
  const upstream =
    isRecord(error) && typeof error.code === "string" ? error.code : "";

  if (statusCode === 40201) {
    return { kind: "account_suspended", statusCode, sanitizedMessage };
  }
  if (statusCode === 40202) {
    return { kind: "rate_limited", statusCode, sanitizedMessage };
  }
  // 401xx is DataForSEO's authentication family; the upstream client also maps
  // HTTP 401 to its own code before the envelope is ever read.
  if (
    upstream === "DATAFORSEO_AUTH_FAILED" ||
    (statusCode !== null && statusCode >= 40100 && statusCode < 40200)
  ) {
    return { kind: "auth_failed", statusCode, sanitizedMessage };
  }
  // 402xx (other than the two named above) is the access family: the account
  // authenticated but may not call this API.
  if (statusCode !== null && statusCode >= 40200 && statusCode < 40300) {
    return { kind: "account_not_enabled", statusCode, sanitizedMessage };
  }
  return { kind: "none", statusCode, sanitizedMessage };
}
