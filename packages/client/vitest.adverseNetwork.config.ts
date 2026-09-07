import { defineConfig } from "vitest/config";

// Isolated config for Phase 25's adverse-network suite (Test Plan DUR-05/DUR-06). Run via
// `pnpm test:adverseNetwork` (never swept into the default `pnpm test` — see root
// vitest.config.ts's `exclude`), the same pattern this project already established for
// convergence/properties/mutation/index/db/benchmark/reconnection: this suite drives real
// WebSocket connections through a real fault-injecting relay (@collab-editor/testkit's
// FaultRelay) against a real in-process server, with deliberately injected multi-second
// delays — fuzz/integration-suite scale, not inner-loop scale.
export default defineConfig({
  test: {
    include: ["src/sync/adverseNetwork.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 400_000,
  },
});
