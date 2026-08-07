import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * The LOW-MEMORY local profile. Not for CI.
 *
 * WHY THIS EXISTS. The default profile lets Vitest size its own fork pool from
 * the CPU count — on this workstation about ten Node processes, each loading the
 * full module graph, over 125 test files. Run alongside `oxlint --type-aware`
 * (which spawns a Go binary that also takes every core) and one or more
 * `wrangler dev` sessions, it exhausted the machine's RAM and took Chrome down
 * with it. The workstation is not a CI server and this profile is what stops it
 * being used as one.
 *
 * The fix is FEWER PROCESSES, not a bigger heap for each. `--max-old-space-size`
 * would have made every one of those ten forks entitled to more memory, which is
 * the opposite of the cure.
 *
 * Use it through `pnpm test:targeted <pattern>` — a bounded run over the files
 * you actually changed. The complete suite belongs to GitHub Actions, where the
 * default profile still applies and parallelism is free.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Two forks, not one: a single fork serialises everything including the
      // module graph load, which makes a targeted run slow enough that people
      // stop using it and go back to running the whole suite.
      pool: "forks",
      poolOptions: {
        forks: {
          minForks: 1,
          maxForks: 2,
        },
      },
      // One file at a time. Isolation still holds; only concurrency drops.
      fileParallelism: false,
      // A watcher is a process that outlives the command that started it, which
      // is exactly the class of thing this profile exists to prevent.
      watch: false,
      // A retry re-runs a whole file in a fresh environment. Locally that is
      // memory spent to hide a flake; CI is where flakes should be visible.
      retry: 0,
      // Bounded so a hung test cannot hold a fork open indefinitely.
      testTimeout: 15_000,
      hookTimeout: 15_000,
      teardownTimeout: 5_000,
    },
  }),
);
