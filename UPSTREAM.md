# Upstream pin — OpenSEO

This repository is a fork of an upstream open-source project, operated by CheckSig
as the **Morgana Search Intelligence Engine**. It is not a rewrite and not a
vendored copy: upstream history is intact and upstream remains the source of
truth for everything except the small, enumerated patch series below.

## Pin

| Field                 | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| `upstream_repository` | https://github.com/every-app/open-seo                     |
| `upstream_release`    | `v0.1.3`                                                  |
| `upstream_commit`     | `9d19e439905a9a954ccdefe22d9270d7c389695d`                |
| `integration_date`    | 2026-08-05                                                |
| `origin`              | https://github.com/checksig-custody/open-seo              |
| `working_branch`      | `morgana/phase-0`                                         |
| `licence`             | MIT (unchanged — see `LICENSE`, `THIRD_PARTY_NOTICES.md`) |

### Why this commit

`v0.1.3` was the latest release at integration time (published 2026-07-30) and
`git compare v0.1.3...main` reported **identical** — zero commits ahead, zero
behind. Pinning the release therefore costs nothing relative to `main` while
giving a stable, human-announced reference point. All releases are `0.x`; there
is no `1.0` line, and the cadence is roughly weekly.

The pin is a **commit SHA**, not a tag: a tag can be moved, a SHA cannot.

## Remotes

```
origin    https://github.com/checksig-custody/open-seo      (fetch + push)
upstream  https://github.com/every-app/open-seo             (fetch)
upstream  DISABLED_no_push_to_upstream                      (push)
```

The upstream push URL is deliberately set to an invalid value. Nothing in this
repository should ever be pushed to the public upstream project, and a typo in a
remote name should fail loudly rather than open a pull request by accident.

`origin/main` is kept as a clean mirror of upstream for diffing. Morgana work
happens on `morgana/phase-0` and later branches.

## Verification

Confirm at any time that the tree still descends from the pinned commit and that
the patch series is the only divergence:

```bash
git merge-base --is-ancestor 9d19e439905a9a954ccdefe22d9270d7c389695d HEAD && echo "pin intact"
git diff --stat 9d19e439905a9a954ccdefe22d9270d7c389695d..HEAD
node scripts/check-upstream.mjs        # read-only: reports distance from upstream
node scripts/assert-isolation.mjs wrangler.staging.jsonc
```

## Local patch series

The patch series is kept deliberately small, isolated and reviewable. No
upstream file is renamed, no directory is restructured, no component is
rebranded, and no upstream code is deleted. Capabilities are disabled through
configuration and guards, never by removing the code that implements them —
deletion would guarantee a conflict on every future upstream merge.

| #      | Files                                                                                                                                                                                    | Purpose                                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | `wrangler.staging.jsonc` (new), `vite.config.ts` (1 line)                                                                                                                                | Isolated staging deploy config. The `vite.config.ts` change adds an env-driven `configPath` to the Cloudflare plugin; unset everywhere else, so upstream behaviour is byte-identical.                                                                 |
| **P2** | `src/server/morgana/phase0-routes.ts` (new), `src/server.ts` (+8 lines)                                                                                                                  | `/healthz`, `/readyz`, `/internal/status`. Handled before upstream dispatch so a probe performs no other work. Returns `null` for every other path.                                                                                                   |
| **P3** | `src/server/lib/runtime-env.ts` (+alias map)                                                                                                                                             | Reads `DATAFORSEO_SEARCH_INTELLIGENCE_API_KEY` in preference to `DATAFORSEO_API_KEY`, so this engine can never use Morgana Brand Monitoring's DataForSEO credential or balance. Falls back to the upstream name, so unpatched behaviour is preserved. |
| **P4** | `src/server/morgana/phase0-{env,guard,cost,logging}.ts` (new), `src/server/morgana/phase0.test.ts` (new), `src/server.ts` (MCP + scheduled guards), `scripts/assert-isolation.mjs` (new) | Zero-spend enforcement, structured logging with redaction, cost centre, MCP kill-switch, scheduled-run refusal, resource isolation guard.                                                                                                             |
| **P5** | `UPSTREAM.md`, `THIRD_PARTY_NOTICES.md`, `scripts/check-upstream.mjs` (new)                                                                                                              | Provenance, attribution, upstream tracking.                                                                                                                                                                                                           |

Everything Morgana-specific lives under `src/server/morgana/` or in a file that
did not exist upstream, except for four small edits to three upstream files
(`src/server.ts`, `src/server/lib/runtime-env.ts`, `vite.config.ts`), each
marked in place with a `MORGANA LOCAL PATCH` comment referencing this document.

### Deliberate non-changes

- **Alchemy is not used or removed.** Upstream deploys via `alchemy.run.ts`
  (pinned prerelease `2.0.0-beta.61`, own state store, `--adopt` used elsewhere
  in the repo, auto-provisions Cloudflare Access). On an account that also holds
  Morgana production, an IaC tool that can adopt existing resources is the wrong
  risk. We deploy with a hand-authored wrangler config instead and leave the
  Alchemy files untouched so upstream merges stay clean.
- **Upstream CI is untouched.** The GitHub token available to this integration
  lacks the `workflow` scope, so `.github/workflows/**` cannot be modified. See
  the Morgana repo's `docs/search-intelligence/OPERATIONS.md`.
- **Branding is unchanged.** The only Morgana identification is the staging
  marker string in the status payload.

## Update procedure

Upstream is **never** merged automatically, and the pin is never advanced by a
script. The procedure is:

```bash
node scripts/check-upstream.mjs          # 1. how far behind are we?
git fetch upstream --tags                # 2. fetch, do not merge
git checkout -b morgana/upstream-<ver>   # 3. dedicated branch
git merge <new-tag>                      # 4. controlled merge, resolve by hand
pnpm install --frozen-lockfile           # 5. reproducible install
pnpm run ci:check && pnpm run test:ci    # 6. full gate
# 7. security review: re-run the checklist in the Morgana repo's SECURITY.md,
#    paying attention to new external calls, new env vars, new telemetry,
#    changes to auth, and anything that could spend money.
node scripts/assert-isolation.mjs wrangler.staging.jsonc
# 8. deploy to staging and verify /healthz, /readyz, /internal/status
# 9. record the new pin in this file, then release.
```

Step 7 is not optional. Upstream is a fast-moving commercial product with
billing, telemetry and AI paths that Phase 0 deliberately disables; a routine
version bump can re-enable any of them.

### What to re-check on every upgrade

- Does `wrangler.staging.jsonc` still declare every Durable Object and Workflow
  class the Worker exports? A new class breaks the upload.
- Did upstream add a cron trigger, a new external host, or new telemetry?
- Did `AUTH_MODE` handling change?
- Did the DataForSEO credential resolution move away from `getEnvValueSync`?
  Patch P3 depends on that single chokepoint.
- Do the migrations still apply cleanly to a **fresh** D1?

## Rollback

Rolling back the engine never deletes data. See
`docs/search-intelligence/OPERATIONS.md` in the Morgana repository for the full
procedure; in short: redeploy the previous Worker version, leave D1 and R2
intact, and leave Morgana production untouched.

## Known conflicts

None at `v0.1.3`. The four edited upstream files are the expected conflict
surface on a future merge; each edit is small and marked with a
`MORGANA LOCAL PATCH` comment so a conflict is easy to resolve deliberately.
