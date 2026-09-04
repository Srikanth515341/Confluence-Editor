import { defineConfig } from "vitest/config";

// Isolated config for Phase 23's reconnection-handshake suite (Test Plan
// §5.1 — the 27-cell RC-* matrix, RC-27's 20-run timing requirement,
// RC-28, RC-33's 4×20 interrupted-handshake runs, RC-34's 32-client
// storm). Run via `pnpm test:reconnection` (never swept into the default
// `pnpm test` — see root vitest.config.ts's `exclude`), the same pattern
// this project already established for convergence/properties/mutation/
// index/db/benchmark: this suite drives many REAL WebSocket connections
// and REAL (if short) reconnect-backoff delays against a real in-process
// server, several minutes end to end — fuzz/integration-suite scale, not
// inner-loop scale.
export default defineConfig({
  test: {
    include: ["src/sync/reconnection.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 30_000,
  },
});
