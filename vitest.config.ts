import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // The convergence suite is deliberately excluded from the default run
      // and gated separately via `pnpm test:convergence` (its own vitest
      // config, packages/testkit/vitest.convergence.config.ts). Until
      // Phase 3 implements integrate(), this suite is EXPECTED to fail,
      // and it must not make the ordinary `pnpm test` loop red for every
      // phase in between (Test Plan §2.2/§12.6; Phase 2's Goal).
      "**/fuzz/convergence.test.ts",
    ],
    environment: "node",
    globals: false,
  },
});
