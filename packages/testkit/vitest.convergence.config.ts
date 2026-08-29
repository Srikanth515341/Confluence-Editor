import { defineConfig } from "vitest/config";

// Isolated config for the convergence suite ONLY (Test Plan §2.2/§12.6).
// Run via `pnpm test:convergence` (never swept into the default `pnpm test`
// — see root vitest.config.ts's `exclude`, which is the other half of
// this split). This suite is EXPECTED to fail until Phase 3 implements
// integrate(); it must not turn the ordinary test loop red for every
// phase in between.
export default defineConfig({
  test: {
    include: ["src/fuzz/convergence.test.ts"],
    environment: "node",
    globals: false,
  },
});
