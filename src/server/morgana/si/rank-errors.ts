/**
 * Morgana Search Intelligence — the typed failure vocabulary.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P12).
 *
 * Phase 1 established that a failure has to describe itself, because two
 * production failures recorded as `provider_error` with a null detail could not
 * be diagnosed afterwards and cost the project its spend authority for a day.
 * This is the same idea given a closed vocabulary: an operator reading a task
 * row should learn what went wrong from the row, not from a log they no longer
 * have.
 *
 * Nothing here ever carries a secret, a header, a cookie or a provider payload.
 * The upstream client attaches raw response bodies to its errors and those
 * bodies echo the request back, so only a class name and a code travel out.
 */

/** Where a failure came from. Widened from phase 1's provider/collection pair. */
export type FailureOrigin =
  | "provider"
  | "collection"
  | "persistence"
  | "budget"
  | "configuration";

export type RankErrorCode =
  | "DATAFORSEO_AUTH_FAILED"
  | "DATAFORSEO_RATE_LIMITED"
  | "DATAFORSEO_UPSTREAM_UNAVAILABLE"
  | "DATAFORSEO_TASK_FAILED"
  | "DATAFORSEO_TASK_EXPIRED"
  | "DATAFORSEO_INVALID_RESPONSE"
  /**
   * This engine stopped polling. NOT a provider verdict.
   *
   * It was already being written into the typed `error_code` column as a bare
   * string, which is how a value nobody declared ends up in a vocabulary
   * everything else is checked against.
   */
  | "DATAFORSEO_COLLECTION_RETRY_EXHAUSTED"
  | "BUDGET_EXHAUSTED"
  | "DUPLICATE_PENDING_TASK"
  | "LIVE_PROVIDER_DISABLED"
  | "PROVIDER_NOT_CONFIGURED"
  | "FIXTURE_IN_PRODUCTION"
  | "PERSISTENCE_FAILED"
  | "UNCLASSIFIED";

export interface TypedFailure {
  origin: FailureOrigin;
  code: RankErrorCode;
  /** The error's class name, sanitised. Never its message. */
  errorClass: string;
  /** A short, authored description. Never derived from provider output. */
  message: string;
  /** The endpoint actually in flight, when the throw site knew it. */
  endpoint: string | null;
}

/** Reduce a token to a fixed alphabet before it is stored or logged. */
function safeToken(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return cleaned === "" ? fallback : cleaned;
}

/**
 * Map an upstream `AppError` code onto this vocabulary.
 *
 * `core.ts` classifies HTTP failures before throwing: 401 becomes
 * `DATAFORSEO_AUTH_FAILED`, 429 `RATE_LIMITED`, 5xx `UPSTREAM_UNAVAILABLE`, and
 * anything else `INTERNAL_ERROR`. Those are the codes that arrive here.
 */
function codeForProvider(upstream: string): RankErrorCode {
  switch (upstream) {
    case "DATAFORSEO_AUTH_FAILED":
      return "DATAFORSEO_AUTH_FAILED";
    case "RATE_LIMITED":
      return "DATAFORSEO_RATE_LIMITED";
    case "UPSTREAM_UNAVAILABLE":
      return "DATAFORSEO_UPSTREAM_UNAVAILABLE";
    case "VALIDATION_ERROR":
      return "DATAFORSEO_INVALID_RESPONSE";
    default:
      // NOT `TASK_FAILED`. An unrecognised upstream code — `INTERNAL_ERROR`
      // above all, which is what `fetchQueuedSerpItems` throws when the
      // response ENVELOPE is unusable — says we failed to read an answer, not
      // that DataForSEO judged the task. Claiming the second was wrong in
      // production on 2026-08-07: three SERPs were recorded as
      // provider-failed and all three collected successfully afterwards.
      return "UNCLASSIFIED";
  }
}

/**
 * Did we learn anything about the task, or only about the connection?
 *
 * The distinction the collector needs: a code in this set means the attempt
 * told us nothing about the SERP, so the receipt is still good and the row must
 * stay collectable. Everything else is a statement about the task itself.
 */
const TRANSPORT_CODES: ReadonlySet<RankErrorCode> = new Set([
  "DATAFORSEO_RATE_LIMITED",
  "DATAFORSEO_UPSTREAM_UNAVAILABLE",
  "DATAFORSEO_INVALID_RESPONSE",
  "DATAFORSEO_AUTH_FAILED",
  "UNCLASSIFIED",
]);

export function isTransportFailure(failure: TypedFailure): boolean {
  return TRANSPORT_CODES.has(failure.code);
}

/**
 * Classify a thrown provider error.
 *
 * A `ZodError` is specifically NOT a task failure: it means the provider
 * answered with a shape we do not understand, which is a different problem with
 * a different fix, and calling it `TASK_FAILED` would send someone to look at
 * DataForSEO's dashboard instead of at the schema.
 */
export function classifyProviderError(
  error: unknown,
  endpoint: string | null,
): TypedFailure {
  const errorClass = safeToken(
    error instanceof Error ? error.name : typeof error,
    "UnknownError",
  );
  if (errorClass === "ZodError") {
    return {
      origin: "provider",
      code: "DATAFORSEO_INVALID_RESPONSE",
      errorClass,
      message: "provider response did not match the expected shape",
      endpoint,
    };
  }
  const upstream =
    error && typeof error === "object" && "code" in error
      ? safeToken(String((error as { code: unknown }).code), "none")
      : "none";
  return {
    origin: "provider",
    code: codeForProvider(upstream),
    errorClass,
    message: `provider call failed (${upstream})`,
    endpoint,
  };
}

/** A failure after the provider answered: our own store, our own mapping. */
export function persistenceFailure(
  error: unknown,
  endpoint: string | null,
): TypedFailure {
  return {
    origin: "persistence",
    code: "PERSISTENCE_FAILED",
    errorClass: safeToken(
      error instanceof Error ? error.name : typeof error,
      "UnknownError",
    ),
    message: "the provider answered but the result could not be stored",
    endpoint,
  };
}

/** A refusal decided before any call — no money, no request, no snapshot. */
export function refusal(
  origin: FailureOrigin,
  code: RankErrorCode,
  message: string,
): TypedFailure {
  return { origin, code, errorClass: "Refused", message, endpoint: null };
}

/** The one-line form stored on the task row and in the log. */
export function failureLine(failure: TypedFailure): string {
  return [
    failure.origin,
    failure.code,
    failure.errorClass,
    failure.endpoint ?? "-",
  ].join(" ");
}

/** Log a failure with no provider text in it. */
export function logRankFailure(
  // A batch operation (keyword volumes) has no single keyword to blame, so the
  // id is nullable rather than faked with an empty string.
  context: { trackedKeywordId: string | null; taskId: string | null },
  failure: TypedFailure,
): void {
  console.error(
    JSON.stringify({
      event: "si_rank_collection_failed",
      tracked_keyword_id: context.trackedKeywordId,
      task_id: context.taskId,
      origin: failure.origin,
      code: failure.code,
      error_class: failure.errorClass,
      endpoint: failure.endpoint,
    }),
  );
}
