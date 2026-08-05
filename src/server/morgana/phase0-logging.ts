/**
 * Morgana Search Intelligence — Phase 0 structured logging and counters.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P4).
 *
 * Every log line carries the same field set so the engine's output can be
 * queried next to Morgana's. Nothing that can carry a credential or an identity
 * is ever emitted: this module redacts rather than trusting call sites.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const PHASE0_COUNTERS = [
  "health_requests",
  "health_failures",
  "readiness_failures",
  "service_binding_requests",
  "service_binding_failures",
  "auth_failures",
  "d1_errors",
  "r2_errors",
  "kv_errors",
  "paid_calls_blocked",
  "unexpected_external_calls",
] as const;

type Phase0Counter = (typeof PHASE0_COUNTERS)[number];

/**
 * Counters are per-isolate and best-effort: they exist so a smoke test and a
 * log query can assert "zero paid calls, zero unexpected external calls"
 * without a metrics backend. They are deliberately NOT persisted — Phase 0
 * introduces no new storage.
 */
const counters = new Map<Phase0Counter, number>();

export function incrementCounter(name: Phase0Counter, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function readCounters(): Record<Phase0Counter, number> {
  const snapshot = {} as Record<Phase0Counter, number>;
  for (const name of PHASE0_COUNTERS) {
    snapshot[name] = counters.get(name) ?? 0;
  }
  return snapshot;
}

/** Test-only: reset counters between cases. */
export function resetCounters(): void {
  counters.clear();
}

// Header names that must never reach a log line, in any casing.
const REDACTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
  "x-api-key",
  "proxy-authorization",
]);

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Long opaque tokens: JWTs, base64 credentials, bearer values.
const JWT_PATTERN = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g;
// `=` is allowed only as trailing base64 padding, never inside the run.
// Including it in the body would make `key=<secret>` match from `key`, which
// both swallows the field label and leaves the `==` padding dangling — the log
// line stops being parseable while the secret is only partly removed.
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9+/_-]{40,}={0,2}/g;

/**
 * Redact a free-text value. Order matters: JWTs first (they would otherwise be
 * partly matched by the generic long-token rule and produce a confusing
 * half-redacted string), then emails, then any other long opaque run.
 */
export function redact(value: string): string {
  return value
    .replace(JWT_PATTERN, "[redacted-jwt]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(LONG_TOKEN_PATTERN, "[redacted]");
}

export function redactHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  headers.forEach((value, key) => {
    safe[key] = REDACTED_HEADERS.has(key.toLowerCase())
      ? "[redacted]"
      : redact(value);
  });
  return safe;
}

type Phase0LogFields = {
  event: string;
  request_id: string;
  trace_id?: string;
  latency_ms?: number;
  status?: number;
  error_code?: string;
  [key: string]: unknown;
};

export function log(
  level: LogLevel,
  environment: string,
  fields: Phase0LogFields,
): void {
  const line: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: "morgana-search-intelligence",
    environment,
    ...fields,
  };
  // Any string value in the payload goes through redaction — a caller cannot
  // accidentally log a token by putting it in a custom field.
  for (const [key, value] of Object.entries(line)) {
    if (typeof value === "string") {
      line[key] = redact(value);
    }
  }
  const serialized = JSON.stringify(line);
  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

/**
 * A request id that is stable for the life of one request. Cloudflare's ray id
 * is preferred so a log line joins the platform trace; otherwise a random id.
 */
export function requestIdFor(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}
