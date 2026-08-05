#!/usr/bin/env node
/**
 * Morgana Search Intelligence — resource isolation guard.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P1).
 *
 * Refuses to let a migration or a deploy target any Morgana Brand Monitoring
 * resource. This exists because the two systems share one Cloudflare account:
 * a mistyped database name or a copy-pasted id is the single most damaging
 * mistake available here, and it is silent.
 *
 * Run before every `d1 migrations apply` and every `wrangler deploy`:
 *   node scripts/assert-isolation.mjs <path-to-wrangler-config>
 *
 * Exits non-zero on any violation. Read-only: it never calls Cloudflare.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

/**
 * Morgana production resources. Matching any of these — by name or by id, in
 * any binding — is a hard failure. Names are matched case-insensitively and as
 * whole values, so `morgana-search-intelligence-staging` does not collide with
 * `morgana-brand-monitor`.
 */
const FORBIDDEN_NAMES = [
  "morgana-brand-monitor",
  "morgana-brand-assets",
  "morgana-mentions",
  "morgana-discovery",
  "morgana-discovery-dlq",
  "checksig-feeds",
  "social_mentions",
  "morgana_intel",
  "checksig-intel",
];

const FORBIDDEN_IDS = ["e98c476d-6df2-4a9e-932b-473ebea891ba"];

/** Every resource name must say what it is and that it is not production. */
const REQUIRED_NAME_FRAGMENT = "search-intelligence";
const REQUIRED_STAGE_FRAGMENT = "staging";

function stripJsonComments(text) {
  // The config is JSONC: strip // and /* */ comments and trailing commas.
  return text
    .replace(
      /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
      (match, comment) => (comment ? "" : match),
    )
    .replace(/,(\s*[}\]])/g, "$1");
}

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("usage: node scripts/assert-isolation.mjs <wrangler-config>");
    process.exit(2);
  }

  let config;
  try {
    config = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
  } catch (error) {
    console.error(
      `isolation guard: cannot parse ${configPath}: ${error.message}`,
    );
    process.exit(2);
  }

  const violations = [];
  const values = collectStrings(config);

  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (FORBIDDEN_NAMES.includes(normalized)) {
      violations.push(
        `references Morgana production resource "${value}" — Search Intelligence must never share a Morgana resource`,
      );
    }
    for (const id of FORBIDDEN_IDS) {
      if (normalized.includes(id)) {
        violations.push(
          `references Morgana production resource id ${id.slice(0, 8)}… — refusing`,
        );
      }
    }
  }

  // Positive assertions: the named resources must be unmistakably ours.
  const named = [
    ...(config.d1_databases ?? []).map((d) => ["d1", d.database_name]),
    ...(config.r2_buckets ?? []).map((r) => ["r2", r.bucket_name]),
    ...(config.kv_namespaces ?? []).map((k) => ["kv", k.binding]),
    ["worker", config.name],
  ];
  for (const [kind, value] of named) {
    if (!value) continue;
    const normalized = String(value).toLowerCase();
    // KV bindings are upstream-owned identifiers (KV, OAUTH_KV) and are scoped
    // by the namespace id, not the binding name, so they are exempt.
    if (kind === "kv") continue;
    if (!normalized.includes(REQUIRED_NAME_FRAGMENT)) {
      violations.push(
        `${kind} "${value}" does not contain "${REQUIRED_NAME_FRAGMENT}" — every resource must be identifiable as Search Intelligence`,
      );
    }
    if (!normalized.includes(REQUIRED_STAGE_FRAGMENT)) {
      violations.push(
        `${kind} "${value}" does not contain "${REQUIRED_STAGE_FRAGMENT}" — Phase 0 provisions staging only`,
      );
    }
  }

  // Deploy posture: no public ingress is the compensating control for the
  // absent Access application, so a config that re-enables ingress must fail.
  if (config.workers_dev !== false) {
    violations.push(
      "workers_dev must be explicitly false — a workers.dev route would publish the engine with no Cloudflare Access in front",
    );
  }
  if (config.preview_urls !== false) {
    violations.push(
      "preview_urls must be explicitly false — a preview URL would publish the engine with no Cloudflare Access in front",
    );
  }
  if (config.routes || config.route) {
    violations.push(
      "routes must not be set — Phase 0 engine is reachable only over the Service Binding",
    );
  }
  if (config.triggers?.crons?.length) {
    violations.push(
      "triggers.crons must be empty — a cron would execute scheduled SEO collection",
    );
  }

  // Spend posture: the zero-cap invariant, asserted on the committed config so
  // it cannot regress between deploys.
  const vars = config.vars ?? {};
  if (vars.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED !== "false") {
    violations.push(
      'SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED must be "false" in Phase 0',
    );
  }
  for (const key of [
    "SEO_DATAFORSEO_DAILY_COST_CAP_USD",
    "SEO_DATAFORSEO_MONTHLY_COST_CAP_USD",
  ]) {
    if (vars[key] !== "0") {
      violations.push(
        `${key} must be "0" in Phase 0 (found ${String(vars[key])})`,
      );
    }
  }
  for (const key of [
    "SEARCH_INTELLIGENCE_MCP_ENABLED",
    "SEARCH_INTELLIGENCE_AI_ENABLED",
    "SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED",
    "SEARCH_INTELLIGENCE_UI_ENABLED",
  ]) {
    if (vars[key] !== "false") {
      violations.push(`${key} must be "false" in Phase 0`);
    }
  }
  // Upstream self-host telemetry is ON by default and posts to a hardcoded
  // PostHog project. Phase 0 must not emit it.
  if (vars.OPENSEO_TELEMETRY_DISABLED !== "1" || vars.DO_NOT_TRACK !== "1") {
    violations.push(
      'OPENSEO_TELEMETRY_DISABLED and DO_NOT_TRACK must both be "1" — upstream self-host telemetry is enabled by default',
    );
  }

  // A secret value must never live in config. Names are fine; values are not.
  for (const [key, value] of Object.entries(vars)) {
    if (/KEY|SECRET|TOKEN|PASSWORD|WEBHOOK/i.test(key) && value) {
      violations.push(
        `vars.${key} looks like a secret — secrets belong in \`wrangler secret put\`, never in config`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(`\nisolation guard FAILED for ${configPath}:\n`);
    for (const violation of violations) {
      console.error(`  ✗ ${violation}`);
    }
    console.error("");
    process.exit(1);
  }

  console.log(`isolation guard passed for ${configPath}`);
  console.log(
    `  worker=${config.name} d1=${config.d1_databases?.[0]?.database_name ?? "none"} r2=${config.r2_buckets?.[0]?.bucket_name ?? "none"}`,
  );
  console.log(
    "  no public ingress, no cron, paid calls off, caps zero, telemetry off",
  );
}

main();
