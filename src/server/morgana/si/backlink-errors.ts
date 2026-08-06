/**
 * Morgana Search Intelligence — typed failures for backlink collection.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P13).
 *
 * Same discipline as the rank collector's classifier, and it exists for the
 * same reason: the upstream client attaches raw provider text to its errors,
 * and raw provider text is neither a stable alphabet to branch on nor
 * something to store. Every failure is reduced here, at the source, to an
 * origin, a class, a typed code and a sanitized message.
 *
 * WHAT IS NEVER RECORDED: the API key, the Authorization header, cookies, the
 * request payload, and any URL carrying a token. A failure explains itself with
 * an endpoint and a code; anything more is a leak waiting for a log reader.
 */

export interface TypedFailure {
  origin:
    | "provider"
    | "collection"
    | "persistence"
    | "budget"
    | "configuration";
  code: string;
  errorClass: string;
  message: string;
  endpoint: string | null;
}

/** Codes this subsystem may write. A fixed alphabet, not free text. */
const BACKLINK_ERROR_CODES = [
  "DATAFORSEO_BACKLINKS_AUTH_FAILED",
  "DATAFORSEO_BACKLINKS_NOT_ENABLED",
  "DATAFORSEO_BACKLINKS_RATE_LIMITED",
  "DATAFORSEO_BACKLINKS_UPSTREAM_UNAVAILABLE",
  "DATAFORSEO_BACKLINKS_INVALID_RESPONSE",
  "DATAFORSEO_BACKLINKS_OPERATION_FAILED",
  "BACKLINK_COLLECTION_RETRY_EXHAUSTED",
  "BUDGET_EXHAUSTED",
  "DUPLICATE_COLLECTION",
  "FIXTURE_IN_PRODUCTION",
  "LIVE_BACKLINK_PREFLIGHT_FAILED",
  "PERSISTENCE_FAILED",
  "UNCLASSIFIED",
] as const;

type BacklinkErrorCode = (typeof BACKLINK_ERROR_CODES)[number];

/** Provider text is matched, never stored. */
const PATTERNS: { code: BacklinkErrorCode; test: RegExp }[] = [
  {
    code: "DATAFORSEO_BACKLINKS_AUTH_FAILED",
    test: /401|unauthor|authent|credential/i,
  },
  {
    code: "DATAFORSEO_BACKLINKS_NOT_ENABLED",
    test: /403|forbidden|not\s+enabled|no\s+access|subscription|not\s+available\s+for\s+your/i,
  },
  {
    code: "DATAFORSEO_BACKLINKS_RATE_LIMITED",
    test: /429|rate\s*limit|too\s+many/i,
  },
  {
    code: "DATAFORSEO_BACKLINKS_UPSTREAM_UNAVAILABLE",
    test: /50\d|timeout|timed out|unavailable|ECONNRESET|network/i,
  },
  {
    code: "DATAFORSEO_BACKLINKS_INVALID_RESPONSE",
    test: /invalid response|invalid result|shape|parse|schema/i,
  },
];

function classify(text: string): BacklinkErrorCode {
  for (const pattern of PATTERNS) {
    if (pattern.test.test(text)) return pattern.code;
  }
  return "DATAFORSEO_BACKLINKS_OPERATION_FAILED";
}

/**
 * A message safe to store: the code's own words, never the provider's.
 *
 * Provider text can contain the target, a request id, or — in the worst case a
 * client library has produced — an echoed header. None of it is needed to act
 * on the failure.
 */
const SAFE_MESSAGES: Record<BacklinkErrorCode, string> = {
  DATAFORSEO_BACKLINKS_AUTH_FAILED:
    "the Search Intelligence DataForSEO credential was rejected",
  DATAFORSEO_BACKLINKS_NOT_ENABLED:
    "the account does not have the Backlinks API enabled",
  DATAFORSEO_BACKLINKS_RATE_LIMITED: "the provider rate-limited the request",
  DATAFORSEO_BACKLINKS_UPSTREAM_UNAVAILABLE:
    "the provider was unreachable or timed out",
  DATAFORSEO_BACKLINKS_INVALID_RESPONSE:
    "the provider returned a response this engine cannot read",
  DATAFORSEO_BACKLINKS_OPERATION_FAILED: "the provider rejected the operation",
  BACKLINK_COLLECTION_RETRY_EXHAUSTED:
    "local collection attempts were exhausted; the operation stays recoverable",
  BUDGET_EXHAUSTED: "the worst-case cost would exceed a configured cap",
  DUPLICATE_COLLECTION:
    "a comparable collection already exists for this window",
  FIXTURE_IN_PRODUCTION:
    "a production engine will not manufacture a fixture backlink profile",
  LIVE_BACKLINK_PREFLIGHT_FAILED: "live backlink collection is not authorised",
  PERSISTENCE_FAILED:
    "the provider answered and this engine failed to store the result",
  UNCLASSIFIED: "the failure could not be classified",
};

export function classifyBacklinkError(
  error: unknown,
  endpoint: string | null,
): TypedFailure {
  const raw =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : "";
  const code = classify(raw);
  return {
    origin: "provider",
    code,
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: SAFE_MESSAGES[code],
    endpoint,
  };
}

/**
 * The provider answered; we failed to store it.
 *
 * A different origin on purpose: the call happened and is billed, so the money
 * stays in the ledger and the failure points at this engine rather than at
 * DataForSEO. Reporting it as a provider fault would send someone to read the
 * wrong logs.
 */
export function backlinkPersistenceFailure(
  error: unknown,
  endpoint: string | null,
): TypedFailure {
  return {
    origin: "persistence",
    code: "PERSISTENCE_FAILED",
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: SAFE_MESSAGES.PERSISTENCE_FAILED,
    endpoint,
  };
}

/** Structured, sanitized, and the only place this subsystem logs a failure. */
export function logBacklinkFailure(
  context: { entityId: string | null; jobId: string | null },
  failure: TypedFailure,
): void {
  console.error(
    JSON.stringify({
      event: "si_backlink_collection_failed",
      entity_id: context.entityId,
      job_id: context.jobId,
      origin: failure.origin,
      code: failure.code,
      error_class: failure.errorClass,
      endpoint: failure.endpoint,
      message: failure.message,
    }),
  );
}
