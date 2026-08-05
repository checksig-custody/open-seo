# Third-party notices

This repository contains, and is derived from, third-party open-source software.
The original licence and copyright are preserved in full.

## OpenSEO

- **Project**: OpenSEO — "Open source alternative to Semrush and Ahrefs"
- **Upstream repository**: https://github.com/every-app/open-seo
- **Homepage**: https://openseo.so
- **Licence**: MIT
- **Copyright**: Copyright (c) 2026 Ben Senescu
- **Integrated release**: `v0.1.3`
- **Integrated commit**: `9d19e439905a9a954ccdefe22d9270d7c389695d`
- **Integration date**: 2026-08-05

The complete MIT licence text is retained unmodified in [`LICENSE`](./LICENSE)
at the root of this repository, and applies to all substantial portions of
OpenSEO reused here — which is to say, essentially the whole of this tree apart
from the Morgana modifications listed below.

### Modifications by CheckSig

This fork is operated internally as the **Morgana Search Intelligence Engine**.
Modifications are limited to the following, and are documented in detail in
[`UPSTREAM.md`](./UPSTREAM.md):

1. An isolated staging deployment configuration (`wrangler.staging.jsonc`) and a
   one-line build hook allowing it to be selected (`vite.config.ts`).
2. Three additive operational endpoints — `/healthz`, `/readyz`,
   `/internal/status` — under `src/server/morgana/`, plus a small dispatch hook
   in `src/server.ts`.
3. A DataForSEO credential alias in `src/server/lib/runtime-env.ts`, so this
   deployment uses its own dedicated credential rather than a shared one.
4. Zero-spend guards, structured logging with redaction, a separate cost centre,
   an MCP kill-switch, a scheduled-run refusal, and a resource isolation guard.
5. Provenance and attribution documentation (this file, `UPSTREAM.md`,
   `scripts/check-upstream.mjs`).

No upstream file was renamed, restructured, rebranded or deleted. No upstream
attribution was removed.

### Trademarks

"OpenSEO" and any associated logos or marks remain the property of their
respective owners. CheckSig uses the name here solely to identify the upstream
project from which this software is derived, as required by the attribution
terms of the MIT licence. Nothing in this repository is intended to suggest
sponsorship or endorsement by the OpenSEO project or its authors.

## Dependencies

This project's runtime and build dependencies carry their own licences,
recorded in `pnpm-lock.yaml` and installed under `node_modules/`. The dependency
tree is installed reproducibly with `pnpm install --frozen-lockfile`.

Note that upstream's `pnpm-workspace.yaml` pins a number of `overrides` to raise
transitive dependencies above known security advisories, and sets a
`minimumReleaseAge` delay as a supply-chain control. Both are retained
unmodified.
