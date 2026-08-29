import { defineConfig } from "vitest/config";

// Isolated config for the mutation-testing suite ONLY (Test Plan §2.8).
// Excluded from the default `pnpm test` for the same reason as
// convergence/properties: even at reduced budgets, string-patching and
// dynamically transpiling ten engine variants and fuzzing each is not
// something the fast inner-loop suite should pay on every run.
export default defineConfig({
  test: {
    include: ["src/mutation/*.test.ts"],
    testTimeout: 180_000,
    environment: "node",
    globals: false,
  },
});
