# Agent guidance

## Engineering principles

- Prefer simple, readable, flat code with minimal indirection.
- Search for existing implementations and installed libraries before creating new helpers or abstractions.
- Abstract when it prevents meaningful drift and makes the result simpler to maintain. Avoid speculative or one-use abstraction layers.
- Keep product data normalized and relationships explicit. Do not encode relational data in JSON or text merely to avoid joins.
- For new application-backed backend functionality, default to: TanStack server function → service → repository.
- Keep schema changes, queries, and mutations compatible with both SQLite and Postgres.
- Use idiomatic TypeScript. Use Zod to validate untrusted data and narrow runtime values at trust boundaries.
- Prefer established project helpers and libraries over hand-rolled implementations.
- Prefer idiomatic TanStack Query, Router, and Form patterns for server state, routing, and submitted forms.

## Log papercuts

When small, non-blocking repository friction occurs—a retried tool call, confusing setup step, flaky command, stale cache, misleading error, or non-obvious gotcha—use the `papercuts` skill and append it to `.agents/PAPERCUTS.md` in the moment. Continue the current task. Real bugs and tracked work are not papercuts, and sensitive data must never be logged.

Do not mine an entire session for papercuts or start a broad cleanup unless the user explicitly asks.

## Preserve review learnings

After a merge-ready or other code review verifies a finding, use `maintain-greptile-rules` only when the finding exposes a recurring or high-risk repository invariant that existing `.greptile/` context and automated checks do not capture. Do not promote one-off bugs or preferences into permanent review rules.

Changes to `.greptile/**`, `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, and `.github/**` alter the review control plane and must receive explicit maintainer review. CODEOWNERS requests that review; where repository settings allow, enable GitHub's requirement for code-owner approval. Repository-specific rules live in `.greptile/`; maintainers should configure or retain a minimal org-enforced Greptile baseline for external-contribution, secret, authentication, billing, CI, and rule-tampering risks. Agents should report an unverified or missing baseline and must not mutate dashboard or organization rules without explicit user authorization.

## LOCAL TEST POLICY (MORGANA LOCAL PATCH — see UPSTREAM.md, patch P18)

**The workstation is not a CI server.** This suite is 125 files and ~1 480 tests;
Vitest sizes its fork pool from the CPU count, so the default profile starts about
ten Node processes each holding the full module graph. Run beside
`oxlint --type-aware` (which spawns a Go binary that also takes every core) and a
`wrangler dev` session or two, it exhausted the developer machine's RAM, crashed
unrelated applications, and made the type-aware linter itself panic.

- **Never** run the complete test suite locally (`pnpm test`, `pnpm test:ci`).
- **Never** start multiple test shards locally.
- **Never** run tests in watch mode (`pnpm test:watch`).
- **Never** leave `wrangler`, `workerd` or `node` background processes running. A
  script that starts one terminates it on success, failure, timeout and Ctrl+C alike.
- Run only the tests directly related to the code you changed:
  **`pnpm test:targeted <pattern>`** — bounded to 2 forks, no file parallelism, no
  watch, no retries.
- Use **at most 2** local test workers.
- Local gate: **`pnpm check:local`** (prettier, knip, tsc ×2, oxlint bounded to 2
  threads). It runs no tests.
- Push and rely on GitHub CI for the complete suite (`pnpm check:ci`).
- **Check CI once. Never poll or wait for it.**
- A green remote CI replaces the local full-suite requirement.

Raising Node's heap is not the fix and must not be used as one: the problem is the
NUMBER of processes, not the memory each is allowed. Fewer workers, targeted tests,
serial execution, remote CI — in that order.

Integration verification belongs on **staging**, reached over its Service Binding,
not on a local `wrangler dev` with a local workerd.
