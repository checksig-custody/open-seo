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
 * Migration preflight — additionally assert the exact database the migrator
 * will target, so a correct config cannot be paired with a wrong CLI argument:
 *   node scripts/assert-isolation.mjs <config> --expect-d1 <database-name>
 *
 * Exits non-zero on any violation. Read-only: it never calls Cloudflare.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

/**
 * Morgana production resources, stored as truncated SHA-256 digests.
 *
 * This fork is PUBLIC. Publishing the literal resource names and the production
 * D1 UUID would put internal infrastructure identifiers in a public repository
 * for no benefit — the guard only ever needs to answer "is this value one of
 * the forbidden ones", and a hash answers that exactly as well. The private
 * Morgana repository documents which resources these correspond to.
 *
 * Matching is case-insensitive and on the whole value, so
 * `morgana-search-intelligence-staging` cannot collide with a hashed entry.
 */
const FORBIDDEN_NAME_HASHES = new Set([
  "85a473b68a354596",
  "cf28d344850bcec7",
  "dea4457437b832e0",
  "2521ed066e97ea17",
  "150b52648b9d542e",
  "181a0a49ca35123a",
  "de4bb646acf32ab2",
  "0e33950f7fd4025f",
  "09f13b870af0efd4",
]);

const FORBIDDEN_ID_HASHES = new Set(["96e3a45820af4479"]);

const digest = (value) =>
  createHash("sha256")
    .update(value.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);

const isForbiddenName = (value) => FORBIDDEN_NAME_HASHES.has(digest(value));
const isForbiddenId = (value) => FORBIDDEN_ID_HASHES.has(digest(value));

/** Every resource name must say what it is. */
const REQUIRED_NAME_FRAGMENT = "search-intelligence";

/**
 * The whole Search Intelligence budget, in USD per month.
 *
 * Asserted here so a config asking for more is refused at deploy time rather
 * than discovered on an invoice. Raising it is a product decision, not a
 * deployment one.
 */
// Budget V2: $10 is a soft operating envelope; $20 is the absolute Worker
// ceiling enforced here before a deployment can make paid calls possible.
const GLOBAL_MONTHLY_HARD_CAP_USD = 20;
const GLOBAL_DAILY_HARD_CAP_USD = 1;
const STAGING_FRAGMENT = "staging";

/**
 * The stage a config claims, and the rule that its resources must agree.
 *
 * This used to be "every resource name must contain `staging`", which was the
 * right check while staging was the only deployment and the only risk was
 * touching Morgana production. Now that a production engine exists the risk is
 * symmetric, so the check is too: a `staging` config may only touch resources
 * whose names say `staging`, and a `production` config may only touch resources
 * whose names do NOT. That catches the mistake this file exists to prevent —
 * deploying one environment's code against the other's database — in both
 * directions, which the old one-way check could not.
 */
function stageOf(config) {
  const declared = config?.vars?.SEARCH_INTELLIGENCE_ENVIRONMENT;
  return declared === "production" ? "production" : "staging";
}

function stageViolation(kind, value, stage) {
  const saysStaging = value.toLowerCase().includes(STAGING_FRAGMENT);
  if (stage === "staging" && !saysStaging) {
    return `${kind} "${value}" does not contain "${STAGING_FRAGMENT}" — a staging config must not touch production resources`;
  }
  if (stage === "production" && saysStaging) {
    return `${kind} "${value}" contains "${STAGING_FRAGMENT}" — a production config must not touch staging resources`;
  }
  return null;
}

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

  // Migration preflight. The config can be correct while the CLI argument is
  // wrong — `wrangler d1 migrations apply <name> -c <config>` takes the database
  // from the ARGUMENT, and a config-only check would happily watch the migrator
  // rewrite the wrong database. Assert the pair agrees.
  const expectIndex = process.argv.indexOf("--expect-d1");
  if (expectIndex !== -1) {
    const expected = process.argv[expectIndex + 1];
    const configured = config.d1_databases?.[0]?.database_name;
    if (!expected) {
      console.error("isolation guard: --expect-d1 requires a database name");
      process.exit(2);
    }
    if (isForbiddenName(expected)) {
      violations.push(
        `migration target "${expected}" is a Morgana production database — refusing`,
      );
    }
    const mismatch = stageViolation(
      "migration target",
      expected,
      stageOf(config),
    );
    if (mismatch) violations.push(mismatch);
    if (configured !== expected) {
      violations.push(
        `migration target "${expected}" does not match the configured d1 database "${String(configured)}" — ambiguous binding, refusing`,
      );
    }
    if (!config.d1_databases || config.d1_databases.length !== 1) {
      violations.push(
        `expected exactly one d1 binding, found ${String(config.d1_databases?.length ?? 0)} — ambiguous migration target`,
      );
    }
  }

  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (isForbiddenName(normalized)) {
      violations.push(
        `"${value}" is a Morgana production resource — Search Intelligence must never share one`,
      );
    }
    if (isForbiddenId(normalized)) {
      violations.push(
        `"${value.slice(0, 8)}…" is a Morgana production resource id — refusing`,
      );
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
    const mismatch = stageViolation(kind, String(value), stageOf(config));
    if (mismatch) violations.push(mismatch);
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

  /**
   * Spend posture, asserted on the committed config so it cannot regress
   * between deploys.
   *
   * This used to demand paid calls off AND both caps zero, in every config.
   * That was right while no deployment had a budget or a credential, and it
   * became wrong when production got both: it would have refused to deploy a
   * correctly funded engine.
   *
   * Staging keeps the strict rule — it has no credential, nothing there should
   * ever spend, and a non-zero cap in a staging config is a mistake worth
   * blocking. Production may spend, but only within a bounded and coherent
   * pair: both caps above zero, and the month able to fund the day.
   *
   * Budget V2 has a $10 soft envelope and a $20 emergency ceiling. The hard
   * ceiling is enforced here; policy/forecast keeps normal operation below it.
   */
  const vars = config.vars ?? {};
  const stage = stageOf(config);
  const paidCallsOn = vars.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED === "true";
  const dailyCap = Number(vars.SEO_DATAFORSEO_DAILY_COST_CAP_USD ?? "0");
  const monthlyCap = Number(vars.SEO_DATAFORSEO_MONTHLY_COST_CAP_USD ?? "0");

  if (stage === "staging") {
    if (vars.SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED !== "false") {
      violations.push(
        'SEARCH_INTELLIGENCE_PAID_CALLS_ENABLED must be "false" in staging — it has no credential and must never spend',
      );
    }
    for (const key of [
      "SEO_DATAFORSEO_DAILY_COST_CAP_USD",
      "SEO_DATAFORSEO_MONTHLY_COST_CAP_USD",
    ]) {
      if (vars[key] !== "0") {
        violations.push(
          `${key} must be "0" in staging (found ${String(vars[key])})`,
        );
      }
    }
  } else if (paidCallsOn) {
    if (!(dailyCap > 0) || !(monthlyCap > 0)) {
      violations.push(
        `paid calls are enabled with a zero cap (daily=${String(dailyCap)}, monthly=${String(monthlyCap)}) — unbounded spend, refusing`,
      );
    }
    if (monthlyCap < dailyCap) {
      violations.push(
        `monthly cap ${String(monthlyCap)} is below the daily cap ${String(dailyCap)} — incoherent budget, refusing`,
      );
    }
    if (dailyCap > GLOBAL_DAILY_HARD_CAP_USD) {
      violations.push(
        `daily cap ${String(dailyCap)} exceeds the ${String(GLOBAL_DAILY_HARD_CAP_USD)} USD Search Intelligence hard cap — refusing`,
      );
    }
    if (monthlyCap > GLOBAL_MONTHLY_HARD_CAP_USD) {
      violations.push(
        `monthly cap ${String(monthlyCap)} exceeds the ${String(GLOBAL_MONTHLY_HARD_CAP_USD)} USD Search Intelligence hard cap — refusing`,
      );
    }
  }
  // What must stay off is what can spend money, reach the network on its own,
  // or reach a human. `SEARCH_INTELLIGENCE_SITE_AUDIT_ENABLED` used to be on
  // this list and is not any more: from phase 5 it is a feature under
  // construction, exactly as `SEARCH_INTELLIGENCE_ENABLED` became at phase 1.
  // What replaced it is stricter, because it names the three phase-5 switches
  // that are not merely a surface — the crawl SCHEDULER, the ALERTS, and the
  // live AI PROVIDER, which is the only phase-5 flag that can cost money.
  for (const key of [
    "SEARCH_INTELLIGENCE_MCP_ENABLED",
    "SEARCH_INTELLIGENCE_AI_ENABLED",
    "SEARCH_INTELLIGENCE_UI_ENABLED",
    "SEARCH_INTELLIGENCE_SITE_AUDIT_ALERTS_ENABLED",
    "SEARCH_INTELLIGENCE_AI_VISIBILITY_ALERTS_ENABLED",
    "SEARCH_INTELLIGENCE_AI_VISIBILITY_LIVE_PROVIDER_ENABLED",
  ]) {
    // An absent key is the default, which is "false" for every flag here.
    if (vars[key] !== undefined && vars[key] !== "false") {
      violations.push(`${key} must be "false" — it is not a surface flag`);
    }
  }
  if (stage === "staging" && vars.SEARCH_INTELLIGENCE_SITE_AUDIT_SCHEDULER_ENABLED !== "false") {
    violations.push('SEARCH_INTELLIGENCE_SITE_AUDIT_SCHEDULER_ENABLED must be "false" in staging');
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
  // Report the spend posture that was actually asserted. A summary line saying
  // "caps zero" under a funded production config would be worse than no line.
  const spendSummary = `paid calls ${paidCallsOn ? "ON" : "off"}, caps ${String(dailyCap)}/day ${String(monthlyCap)}/month`;
  console.log(`  no public ingress, no cron, ${spendSummary}, telemetry off`);
}

main();
