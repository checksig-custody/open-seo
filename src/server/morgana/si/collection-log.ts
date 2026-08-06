/**
 * Morgana Search Intelligence — collection failure: raising it, describing it,
 * logging it.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P11).
 *
 * Its own module because what it must NOT do is the point: the upstream client
 * attaches the raw provider response body to its errors, and that body echoes
 * the request back. Keeping the redaction in one named place means the rule is
 * reviewable, rather than repeated inline at every call site that logs.
 *
 * WHY IT ALSO DESCRIBES. The first live production run failed twice and neither
 * failure could be explained afterwards, because the only record was a job row
 * reading `skip_reason = 'provider_error'`, `last_error = NULL`. That row was
 * wrong in both halves: the reason was a guess — the catch that wrote it also
 * covers persistence, so a D1 failure was indistinguishable from a provider
 * one — and the detail was absent. An unexplained failure is a reason to leave
 * spend authority switched off, so a failure that cannot describe itself is
 * expensive in the most literal sense.
 */

/**
 * A provider call that threw, tagged with the endpoint that was in flight.
 *
 * The collector makes three calls and the catch is around all of them, so
 * without this the endpoint recorded against a failure was whichever one the
 * catch happened to name — in practice the overview, which was frequently the
 * one call that had succeeded.
 */
export class CollectorCallError extends Error {
  readonly endpointPath: string;

  constructor(endpointPath: string, options: { cause: unknown }) {
    // Only our own endpoint string reaches the message. The cause keeps the
    // provider's text, and nothing in this module reads it.
    super(`provider call failed: ${endpointPath}`, options);
    this.name = "CollectorCallError";
    this.endpointPath = endpointPath;
  }
}

/** What failed and where, carrying no provider text at all. */
export interface FailureDescriptor {
  /**
   * `provider` — a DataForSEO call threw. Money may have been spent.
   * `collection` — everything else: the ledger write, the snapshot write, a
   * defect in the mapping. No provider call is known to have failed, so none
   * is recorded as failed.
   */
  origin: "provider" | "collection";
  /** The endpoint in flight, when the throw site knew which one it was. */
  endpointPath: string | null;
  errorName: string;
  errorCode: string;
}

/**
 * Reduce a token to a fixed, boring alphabet before it is stored or logged.
 *
 * Error names and codes are supposed to be short identifiers, but they arrive
 * from a dependency and end up in a D1 column and a log line. Constraining the
 * character set means neither can be used to smuggle provider text, a newline
 * or a quote into either.
 */
function safeToken(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return cleaned === "" ? fallback : cleaned;
}

function readNameAndCode(error: unknown): {
  errorName: string;
  errorCode: string;
} {
  const errorName = safeToken(
    error instanceof Error ? error.name : typeof error,
    "UnknownError",
  );
  const errorCode =
    error && typeof error === "object" && "code" in error
      ? safeToken(String((error as { code: unknown }).code), "none")
      : "none";
  return { errorName, errorCode };
}

/**
 * Classify a collection failure.
 *
 * A `CollectorCallError` is unwrapped: its endpoint is kept and the error
 * class and code reported are the ones of the underlying provider error, not
 * of the wrapper, which would otherwise report `CollectorCallError` for every
 * distinct provider fault.
 */
export function describeCollectionFailure(error: unknown): FailureDescriptor {
  if (error instanceof CollectorCallError) {
    return {
      origin: "provider",
      endpointPath: error.endpointPath,
      ...readNameAndCode(error.cause),
    };
  }
  return {
    origin: "collection",
    endpointPath: null,
    ...readNameAndCode(error),
  };
}

/**
 * The one-line form stored in `domain_refresh_jobs.last_error`.
 *
 * Every part is either a fixed word or a token that went through `safeToken`,
 * so this is safe to persist and to render.
 */
export function failureSummary(failure: FailureDescriptor): string {
  return [
    failure.origin,
    failure.endpointPath ?? "-",
    failure.errorName,
    failure.errorCode,
  ].join(" ");
}

/**
 * Log a collection failure without leaking provider text, and return the
 * classification so the caller can record the same facts durably.
 *
 * The upstream client attaches the raw response body to its errors, and that
 * body can echo the request — including the target domain and, on an auth
 * failure, header fragments. Only the error's class and code travel out.
 */
export function logCollectionFailure(
  entityId: string,
  error: unknown,
): FailureDescriptor {
  const failure = describeCollectionFailure(error);
  console.error(
    JSON.stringify({
      event: "si_live_collection_failed",
      entity_id: entityId,
      origin: failure.origin,
      endpoint_path: failure.endpointPath,
      error_name: failure.errorName,
      error_code: failure.errorCode,
    }),
  );
  return failure;
}
