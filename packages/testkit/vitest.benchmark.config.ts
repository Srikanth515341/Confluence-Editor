import { defineConfig } from "vitest/config";

// Isolated config for the scaling benchmark (Phase 19, Engine Spec §8.2-
// §8.3, RFC §10.4) and the compression/memory benchmark (Phase 20, Engine
// Spec §7.5). Run via `pnpm test:benchmark` (never swept into the default
// `pnpm test` — see root vitest.config.ts's `exclude`) — a timing/memory-
// sensitive benchmark doesn't belong in a shared-CPU inner-loop suite, the
// same reasoning as convergence/properties/mutation/the PositionIndex
// cross-check.
export default defineConfig({
  test: {
    include: ["src/benchmark/*.bench.test.ts"],
    environment: "node",
    globals: false,
  },
});
