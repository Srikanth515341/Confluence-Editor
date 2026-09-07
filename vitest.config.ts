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
      // Same reasoning as the convergence suite above: the property-based
      // suite (Test Plan §2.5, PROP-1…5) runs 5 properties at 10,000
      // generated cases each and belongs in its own gate, run via
      // `pnpm test:properties` (packages/testkit/vitest.properties.config.ts).
      "**/property/**/*.test.ts",
      // Same reasoning again: the mutation-testing suite (Test Plan §2.8)
      // string-patches and dynamically transpiles ten engine variants and
      // fuzzes each one — run via `pnpm test:mutation`
      // (packages/testkit/vitest.mutation.config.ts), never swept into
      // the default run.
      "**/mutation/**/*.test.ts",
      // Phase 15's schema DoD suite requires a real, migrated Postgres
      // instance (`docker compose up -d` + `pnpm db:migrate`) — most
      // dev/CI environments don't have one running by default, so it's
      // gated separately via `pnpm test:db`
      // (packages/server/vitest.db.config.ts), same reasoning as the
      // three suites above.
      "**/db/**/*.db.test.ts",
      // Phase 19's PositionIndex reference cross-check (Test Plan §2.6 I6):
      // 10,000 seeds against a linear-scan oracle, ~50s — fuzz-suite scale,
      // gated the same way via `pnpm test:index`
      // (packages/engine/vitest.crosscheck.config.ts). The FAST, direct
      // contract tests (positionIndex.test.ts) stay in the default run.
      "**/positionIndex.crosscheck.test.ts",
      // Phase 19's scaling benchmark (Engine Spec §8.2-§8.3, RFC §10.4) —
      // timing-sensitive, gated the same way via `pnpm test:benchmark`
      // (packages/testkit/vitest.benchmark.config.ts).
      "**/benchmark/**/*.bench.test.ts",
      // Phase 23's reconnection-handshake suite (Test Plan §5.1): the
      // 27-cell RC-* matrix, RC-27's 20-run timing requirement, RC-33's
      // 4×20 interrupted-handshake runs, RC-34's 32-client storm — many
      // real WebSocket connections and real (if short) reconnect-backoff
      // delays against a real in-process server, several minutes end to
      // end. Gated the same way via `pnpm test:reconnection`
      // (packages/client/vitest.reconnection.config.ts).
      "**/reconnection.test.ts",
      // Phase 25's adverse-network suite (Test Plan DUR-05/DUR-06): real WebSocket
      // connections through a real fault-injecting relay (@collab-editor/testkit's
      // FaultRelay), deliberately injecting multi-second delays — gated the same way via
      // `pnpm test:adverseNetwork` (packages/client/vitest.adverseNetwork.config.ts).
      "**/adverseNetwork.test.ts",
    ],
    environment: "node",
    globals: false,
  },
});
