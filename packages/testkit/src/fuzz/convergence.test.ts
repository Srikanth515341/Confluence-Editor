import { describe, expect, it } from "vitest";
import { createEngineAdapter } from "./engineAdapter.js";
import { runFuzzSuite } from "./runTrial.js";
import { ALL_CONFIGS } from "./configs.js";

/**
 * The convergence suite (Test Plan §2.2/§2.3, PRD M1(a)/C-7).
 *
 * Deliberately EXCLUDED from the default `pnpm test` run (see root
 * vitest.config.ts's `exclude`) and run in isolation via
 * `pnpm test:convergence`, because — until Phase 3 implements
 * integrate() — every trial here is EXPECTED to fail. Wiring this suite
 * in now, before the algorithm exists, means Phase 3 is written against a
 * working oracle from its first line, rather than a harness that tests
 * whatever the algorithm happens to do (Implementation Plan, Phase 2
 * rationale).
 */
const SEEDS_PER_CONFIG = 10_000;

describe.each(ALL_CONFIGS)("convergence suite — $name", (config) => {
  it(`converges across ${SEEDS_PER_CONFIG} seeds`, () => {
    const factory = createEngineAdapter();
    const summary = runFuzzSuite(config, factory, SEEDS_PER_CONFIG);

    if (summary.converged !== summary.total) {
      const firstError = summary.errored[0];
      const reason = firstError ? String(firstError.error) : "no error captured";
      throw new Error(
        `${config.name}: ${summary.converged}/${summary.total} converged, ` +
          `${summary.errored.length} errored, ${summary.diverged.length} diverged, ` +
          `${summary.stuckPending.length} stuck-pending. First error: ${reason} ` +
          "This failure is EXPECTED until Phase 3 implements integrate() " +
          "(Engine Spec §4.3) — see Implementation Plan Phase 2.",
      );
    }

    expect(summary.converged).toBe(summary.total);
  });
});
