import { defineConfig } from "vitest/config";

// Isolated config for the M7 load sweep (Phase 38, Test Plan §4.4 PERF-M7 / §4.2 PERF-M4).
// Run via `pnpm load:sweep` (never swept into the default `pnpm test` — see root
// vitest.config.ts's `exclude`) — many real WebSocket connections against a real 50,000-
// character document, running for minutes to hours depending on LOAD_LEVELS/
// LOAD_EDIT_DURATION_MS, the same "isolated, own runtime budget" reasoning as
// convergence/properties/mutation/reconnection/adverseNetwork.
export default defineConfig({
  test: {
    include: ["src/load/runLoadSweep.script.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 24 * 60 * 60 * 1000,
    hookTimeout: 60_000,
  },
});
