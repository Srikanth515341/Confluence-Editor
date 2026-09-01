import { defineConfig } from "vitest/config";

// Isolated config for Phase 19's PositionIndex reference cross-check ONLY
// (Test Plan §2.6, Invariant I6) — 10,000 fuzz seeds against a linear-scan
// oracle, ~50s. Run via `pnpm test:index` (never swept into the default
// `pnpm test` — see root vitest.config.ts's `exclude`, the other half of
// this split), the same pattern this project already uses for
// convergence/properties/mutation.
export default defineConfig({
  test: {
    include: ["src/positionIndex.crosscheck.test.ts"],
    environment: "node",
    globals: false,
  },
});
