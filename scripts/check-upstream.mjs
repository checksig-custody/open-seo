#!/usr/bin/env node
/**
 * Morgana Search Intelligence — upstream drift report.
 *
 * MORGANA LOCAL PATCH (see UPSTREAM.md, patch P5).
 *
 * READ-ONLY BY DESIGN. This script reports how far the pinned commit is from
 * the latest upstream release. It deliberately does NOT:
 *   - fetch, merge or rebase
 *   - modify the pin in UPSTREAM.md
 *   - deploy anything
 *
 * Advancing the pin is a human decision that goes through the update procedure
 * documented in UPSTREAM.md, including a security review. An automatic upgrade
 * path for a dependency that can spend money and call third-party APIs is
 * exactly what we do not want.
 *
 * Usage: node scripts/check-upstream.mjs [--json]
 * Exit codes: 0 up to date · 3 behind upstream · 2 could not determine
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

const UPSTREAM_REPO = "every-app/open-seo";
const PIN_FILE = new URL("../UPSTREAM.md", import.meta.url);

function readPin() {
  const text = readFileSync(PIN_FILE, "utf8");
  const commit = /`upstream_commit`\s*\|\s*`([0-9a-f]{40})`/.exec(text)?.[1];
  const release = /`upstream_release`\s*\|\s*`([^`]+)`/.exec(text)?.[1];
  if (!commit || !release) {
    throw new Error("could not parse the pin out of UPSTREAM.md");
  }
  return { commit, release };
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function main() {
  const asJson = process.argv.includes("--json");
  let pin;
  try {
    pin = readPin();
  } catch (error) {
    console.error(`check-upstream: ${error.message}`);
    process.exit(2);
  }

  let latestTag;
  let comparison;
  try {
    latestTag = gh([
      "api",
      `repos/${UPSTREAM_REPO}/releases/latest`,
      "--jq",
      ".tag_name",
    ]);
    comparison = JSON.parse(
      gh([
        "api",
        `repos/${UPSTREAM_REPO}/compare/${pin.commit}...${latestTag}`,
        "--jq",
        "{ahead:.ahead_by, behind:.behind_by, status:.status}",
      ]),
    );
  } catch (error) {
    console.error(
      "check-upstream: could not query upstream (is `gh` installed and authenticated?)",
    );
    console.error(
      String(error.stderr ?? error.message)
        .trim()
        .split("\n")[0],
    );
    process.exit(2);
  }

  const behind = comparison.ahead ?? 0;
  const report = {
    upstream_repository: `https://github.com/${UPSTREAM_REPO}`,
    pinned_release: pin.release,
    pinned_commit: pin.commit,
    latest_release: latestTag,
    commits_behind_latest_release: behind,
    up_to_date: behind === 0,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`upstream    ${report.upstream_repository}`);
    console.log(`pinned      ${pin.release} (${pin.commit.slice(0, 12)}…)`);
    console.log(`latest      ${latestTag}`);
    if (behind === 0) {
      console.log("status      up to date with the latest upstream release");
    } else {
      console.log(`status      ${behind} commit(s) behind ${latestTag}`);
      console.log("");
      console.log("This is a report, not an action. To upgrade, follow the");
      console.log("update procedure in UPSTREAM.md — fetch, branch, merge by");
      console.log(
        "hand, run the full gate, repeat the security review, deploy",
      );
      console.log("to staging, and only then move the pin.");
    }
  }

  // Non-zero on drift so a scheduled check can surface it, without ever
  // implying the upgrade happened.
  process.exit(behind === 0 ? 0 : 3);
}

main();
