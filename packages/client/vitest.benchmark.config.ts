import { defineConfig } from "vitest/config";

// Isolated config for Phase 22's keystroke-latency benchmark (API Spec
// §7.9 / PRD M3's 16ms budget — "keystroke latency unaffected [by the
// durable queue] — measure p99 with and without the queue"). Run via
// `pnpm test:benchmark` (never swept into the default `pnpm test` — see
// root vitest.config.ts's `exclude`), the same pattern
// packages/testkit/vitest.benchmark.config.ts already established for
// its own timing-sensitive benchmarks (Phases 19-21) — a real wall-clock
// measurement doesn't belong in a shared-CPU inner-loop suite.
export default defineConfig({
  test: {
    include: ["src/**/benchmark/*.bench.test.ts"],
    environment: "node",
    globals: false,
  },
});
