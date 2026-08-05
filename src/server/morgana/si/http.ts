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
    provider_status: meta.providerStatus ?? "unknown",
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
function isRecord(value: unknown): value is Record<string, unknown> {
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
