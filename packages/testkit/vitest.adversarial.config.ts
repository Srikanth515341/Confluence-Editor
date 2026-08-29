import { defineConfig } from "vitest/config";

// Isolated config for the adversarial suite ONLY (Test Plan §2.4). Unlike
// convergence/properties, these 22 cases are fast and deterministic — no
// exclusion from the default `pnpm test` include is needed, so this suite
// runs there too. `pnpm test:adversarial` exists as its own named command
// per the Phase 5 Definition of Done, for the same reason `test:convergence`
// and `test:properties` do: its own isolated, unambiguous CI signal.
export default defineConfig({
  test: {
    include: ["src/adversarial/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
