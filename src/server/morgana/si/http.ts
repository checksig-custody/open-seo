import type { Phase0Config } from "../phase0-env";

/**
 * Morgana Search Intelligence — HTTP helpers.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P6).
 *
 * Response shaping and request-input coercion, shared by the entry point and
 * the route table so both produce identical envelopes and identical headers.
 */

const SI_API_VERSION = "2026-08-06";
export const SI_PATH_PREFIX = "/internal/si/";

/**
 * WHAT `provider_status` MEANS ON THE WIRE, which is not what it means inside.
 *
 * Internally `fixture` is the spend posture "a credential we may not use" —
 * paid calls are off. On the wire the same word says something entirely
 * different to the client: THIS DATA IS SYNTHETIC. Morgana refuses a `fixture`
 * payload in production, correctly, because showing invented numbers as though
 * they were measurements is the one failure this subsystem cannot have.
 *
 * Those two meanings collided the moment the product surfaces were switched on
 * with paid calls off — the correct posture. Every read of REAL STORED ROWS was
 * being stamped `fixture` and refused, so an entire finished product reported
 * itself as synthetic because the collector behind it was idle.
 *
 * A credential is present in both `fixture` and `live`, so the only difference
 * between them is whether new collection may happen — a fact about the FUTURE,
 * not about the rows in this response. `read_only` says exactly that, and
 * leaves `fixture` to mean what the client always thought it meant.
 *
 * Nothing that decides whether to spend reads this value; the collectors take
 * the internal status directly. This is a rename at the boundary, and it can
 * therefore not loosen a budget guard.
 */
/**
 * Does this response actually contain a synthetic fact?
 *
 * `providerStatus` describes whether a future collection may spend. It cannot
 * establish the provenance of a row read from D1. Keep the scan deliberately
 * narrow: only explicit provenance fields count, never an arbitrary string in
 * a title, URL or keyword.
 */
function containsFixtureProvenance(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFixtureProvenance);
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    record.source === "fixture" ||
    record.provider === "fixture" ||
    record.provider_status === "fixture"
  ) {
    return true;
  }
  return Object.values(record).some(containsFixtureProvenance);
}

function reportedProviderStatus(
  status: string | undefined,
  data: unknown,
): string {
  if (status === undefined) return "unknown";
  // A paused collector is not synthetic data. Conversely, a genuine fixture
  // row must retain its fixture envelope so Morgana's production guard rejects
  // it at the single client choke point.
  return status === "fixture" && !containsFixtureProvenance(data)
    ? "read_only"
    : status;
}

interface EnvelopeMeta {
  cacheStatus?: "hit" | "miss" | "not_applicable";
  providerStatus?: string;
  costEstimatedUsd?: number;
  costActualUsd?: number;
}

/**
 * Every response carries this wrapper so the client can validate one shape and
 * detect a version mismatch, rather than mis-parsing a changed payload.
 */
export function envelope(
  config: Phase0Config,
  data: unknown,
  meta: EnvelopeMeta = {},
) {
  return {
    api_version: SI_API_VERSION,
    engine_version: config.ENGINE_UPSTREAM_RELEASE,
    upstream_version: config.ENGINE_UPSTREAM_RELEASE,
    upstream_commit: config.ENGINE_UPSTREAM_COMMIT,
    environment: config.SEARCH_INTELLIGENCE_ENVIRONMENT,
    data,
    fetched_at: new Date().toISOString(),
    cache_status: meta.cacheStatus ?? "not_applicable",
    provider_status: reportedProviderStatus(meta.providerStatus, data),
    cost_estimated_usd: meta.costEstimatedUsd ?? 0,
    cost_actual_usd: meta.costActualUsd ?? 0,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // The engine renders nothing and is called machine-to-machine only.
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

export function badRequest(code: string, message: string): Response {
  return json({ error: message, code }, 400);
}

/** Predicate, not an assertion: the check and the narrowing cannot drift apart. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJson(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Bounded positive integer from a query parameter, with a hard ceiling. */
export function clamp(
  raw: string | null,
  fallback: number,
  max: number,
): number | undefined {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
