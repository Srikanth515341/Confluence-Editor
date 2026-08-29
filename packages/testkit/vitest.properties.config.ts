import { defineConfig } from "vitest/config";

// Isolated config for the property-based suite ONLY (Test Plan §2.5,
// PROP-1…5). Run via `pnpm test:properties` (never swept into the
// default `pnpm test` — see root vitest.config.ts's `exclude`). Kept
// separate for the same reason as the convergence suite: 5 properties at
// 10,000 generated cases each is a fuzz-suite runtime, not something the
// fast inner-loop `pnpm test` should pay on every run.
export default defineConfig({
  test: {
    include: ["src/property/**/*.test.ts"],
    testTimeout: 120_000,
    environment: "node",
    globals: false,
  },
});
