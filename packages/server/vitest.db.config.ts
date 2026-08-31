import { defineConfig } from "vitest/config";

// Isolated config for the schema/migration DoD suite ONLY (Phase 15).
// Run via `pnpm test:db` (never swept into the default `pnpm test` — see
// root vitest.config.ts's `exclude`) because it requires a real, migrated
// Postgres instance (`docker compose up -d`, `pnpm db:migrate`) — the
// same reasoning as the convergence/properties/mutation suites being
// isolated in packages/testkit (CLAUDE.md, "How to run the test suite").
export default defineConfig({
  test: {
    include: ["src/db/**/*.db.test.ts"],
    environment: "node",
    globals: false,
    // Schema tests share one Postgres instance and use explicit
    // transactions per test (see schema.db.test.ts) — safe to run serially
    // in one worker, and serial keeps failure output easy to read.
    fileParallelism: false,
    // The EXPLAIN-plan test bulk-inserts 120,000 rows (via unnest/
    // generate_series, not per-row round trips) so the planner has a
    // table large enough to genuinely prefer the primary-key index over a
    // sequential scan (see that test's own comment) — real work against a
    // real database, which the default 5s test / 10s hook timeouts are far
    // too tight for. Baseline runtime is ~15-18s; a 30s budget was observed
    // to flake under ordinary system load (a run overlapping another
    // pnpm test invocation took 40s and timed out) — 60s leaves real
    // headroom rather than trading one flaky threshold for a merely less
    // flaky one.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
